import * as assert from "assert";
import * as express from "express";
import * as graphql from "graphql";
import { WebSocketEvent } from "grip";
import { v4 as uuidv4 } from "uuid";
import { assertNever } from "../graphql-epcp-pubsub/EpcpPubSubMixin";
import { default as AcceptAllGraphqlSubscriptionsMessageHandler } from "../graphql-ws/AcceptAllGraphqlSubscriptionsMessageHandler";
import { filterTable, ISimpleTable } from "../simple-table/SimpleTable";
import {
  ComposedConnectionListener,
  composeMessageHandlers,
  IConnectionListener,
} from "../websocket-over-http-express/WebSocketOverHttpConnectionListener";
import WebSocketOverHttpExpress, {
  IWebSocketOverHTTPConnectionInfo,
} from "../websocket-over-http-express/WebSocketOverHttpExpress";
import { IGraphqlSubscription } from "./GraphqlSubscription";
import GraphqlWebSocketOverHttpConnectionListener, {
  getSubscriptionOperationFieldName,
  IGraphqlWsStartMessage,
  IGraphqlWsStopMessage,
  isGraphqlWsStartMessage,
  isGraphqlWsStopMessage,
} from "./GraphqlWebSocketOverHttpConnectionListener";
import { cleanupStorageAfterConnection } from "./GraphqlWsOverWebSocketOverHttpStorageCleaner";
import { IStoredPubSubSubscription } from "./PubSubSubscriptionStorage";
import { IWebSocketOverHttpGraphqlSubscriptionContext } from "./WebSocketOverHttpGraphqlContext";

interface ISubscriptionStoringMessageHandlerOptions {
  /** WebSocket Connection Info */
  connection: {
    /** Connection ID */
    id: string;
  };
  /** Table in which gql subscriptions are stored */
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>;
}

/**
 * Websocket message handler that will watch for graphql-ws GQL_START events that initiate subscriptions
 * and store information about each subscription to the provided subscriptionStorage.
 */
const SubscriptionStoringMessageHandler = (
  options: ISubscriptionStoringMessageHandlerOptions,
) => async (message: string) => {
  const graphqlWsEvent = JSON.parse(message);
  if (!isGraphqlWsStartMessage(graphqlWsEvent)) {
    return;
  }
  const operationId = graphqlWsEvent.id;
  assert(operationId, "graphql-ws GQL_START message must have id");
  const payload = graphqlWsEvent.payload;
  const query = payload && payload.query;
  assert(query, "graphql-ws GQL_START message must have query");
  const subscriptionFieldName = getSubscriptionOperationFieldName(
    graphqlWsEvent.payload,
  );
  await options.subscriptionStorage.insert({
    connectionId: options.connection.id,
    createdAt: new Date(Date.now()).toISOString(),
    id: uuidv4(),
    operationId,
    startMessage: message,
    subscriptionFieldName,
  });
};

/** WebSocket Message Handler that calls a callback on graphql-ws start message */
const GraphqlWsStartMessageHandler = (
  onMessage: (startMessage: IGraphqlWsStartMessage) => Promise<string | void>,
) => async (message: string) => {
  const graphqlWsEvent = JSON.parse(message);
  if (!isGraphqlWsStartMessage(graphqlWsEvent)) {
    return;
  }
  return onMessage(graphqlWsEvent);
};

/** WebSocket Message Handler that calls a callback on graphql-ws stop message */
const GraphqlWsStopMessageHandler = (
  onMessage: (stopMessage: IGraphqlWsStopMessage) => Promise<string | void>,
) => async (message: string) => {
  const graphqlWsEvent = JSON.parse(message);
  if (!isGraphqlWsStopMessage(graphqlWsEvent)) {
    return;
  }
  return onMessage(graphqlWsEvent);
};

/**
 * WebSocket message handler that will watch for graphql-ws GQL_STOP events that stop subscriptions,
 * and remove corresponding subscription records from subscriptionStorage.
 */
const SubscriptionDeletingMessageHandler = (
  options: ISubscriptionStoringMessageHandlerOptions,
) => async (message: string) => {
  const graphqlWsEvent = JSON.parse(message);
  if (!isGraphqlWsStopMessage(graphqlWsEvent)) {
    return;
  }
  const operationId = graphqlWsEvent.id;
  assert(operationId, "graphql-ws GQL_STOP message must have id");
  const subscriptionRowsForThisEvent = await filterTable(
    options.subscriptionStorage,
    sub => {
      return (
        sub.connectionId === options.connection.id &&
        sub.operationId === graphqlWsEvent.id
      );
    },
  );
  await Promise.all(
    subscriptionRowsForThisEvent.map(sub =>
      options.subscriptionStorage.delete({ id: sub.id }),
    ),
  );
};

/** Create a function that will cleanup after a collection by removing that connection's subscriptions in a ISimpleTable<GraphqlSubscription> */
const SubscriptionStorageConnectionCleanup = (
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>,
) => async (connection: IWebSocketOverHTTPConnectionInfo): Promise<void> => {
  const subscriptionsForConnection = await filterTable(
    subscriptionStorage,
    subscription => subscription.connectionId === connection.id,
  );
  await Promise.all(
    subscriptionsForConnection.map(subscription =>
      subscriptionStorage.delete(subscription),
    ),
  );
  return;
};

/** Message handler that will properly handle graphql-ws subscription operations
 * by calling `subscribe` export of `graphql` package
 */
const ExecuteGraphqlWsSubscriptionsMessageHandler = (options: {
  /** ws-over-http info */
  webSocketOverHttp: {
    /** info aobut the ws-over-http connection */
    connection: IWebSocketOverHTTPConnectionInfo;
  };
  /** table to store PubSub subscription info in */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
  /** graphql resolver root value */
  rootValue?: any;
  /** graphql schema to evaluate subscriptions against */
  schema: graphql.GraphQLSchema;
}) => async (message: string) => {
  const graphqlWsEvent = JSON.parse(message);
  const operation = graphqlWsEvent && graphqlWsEvent.payload;
  if (!(isGraphqlWsStartMessage(graphqlWsEvent) && operation)) {
    // not a graphql-ws subscription start. Do nothing
    return;
  }
  const queryDocument = graphql.parse(operation.query);
  // const validationErrors = graphql.validate(queryDocument)
  const operationAST = graphql.getOperationAST(
    queryDocument,
    operation.operationName || "",
  );
  if (!(operationAST && operationAST.operation === "subscription")) {
    // not a subscription. do nothing
    return;
  }
  const contextValue: IWebSocketOverHttpGraphqlSubscriptionContext = {
    webSocketOverHttp: {
      connection: options.webSocketOverHttp.connection,
      graphql: {
        schema: options.schema,
      },
      graphqlWs: {
        startMessage: graphqlWsEvent,
      },
      pubSubSubscriptionStorage: options.pubSubSubscriptionStorage,
    },
  };
  const subscriptionAsyncIterator = await graphql.subscribe({
    contextValue,
    document: queryDocument,
    operationName: operation.operationName,
    rootValue: options.rootValue,
    schema: options.schema,
    variableValues: operation.variables,
  });
  if ("next" in subscriptionAsyncIterator) {
    // may need to call this to actually trigger underlying subscription resolver.
    // When underlying PubSub has SubscriptionStoragePubSubMixin, this will result in storing some info
    // about what PubSub event names are subscribed to.
    subscriptionAsyncIterator.next();
  }
  if (
    "return" in subscriptionAsyncIterator &&
    subscriptionAsyncIterator.return
  ) {
    // but we don't want to keep listening on this terator. Subscription events will be broadcast to EPCP gateway
    // at time of mutation.
    subscriptionAsyncIterator.return();
  }
};

/** Interface for ws-over-http connections stored in the db */
export interface IStoredConnection {
  /** When the connection was createdAt (ISO_8601 string) */
  createdAt: string;
  /** unique connection id */
  id: string;
  /** datetime that this connection should timeout and be deleted (ISO_8601 string) */
  expiresAt: string;
}

/**
 * ConnectionListener that will store Connection info.
 * On connection open, store a record in connectionStorage.
 * On every subsequent ws-over-http request, consider whether to update connection.expiresAt to push out the date at which it should be considered expired because of inactivity/timeout.
 * To minimize db reads/writes, store a Meta-Connection-Expiration-Delay-At value in the ws-over-http state to help decide when to update connection.expiresAt with a write to connectionStorage.
 */
const ConnectionStoringConnectionListener = (options: {
  /** info about the connection */
  connection: IWebSocketOverHTTPConnectionInfo;
  /** table to store information about each ws-over-http connection */
  connectionStorage: ISimpleTable<IStoredConnection>;
  /** how often to ask ws-over-http gateway to make keepalive requests */
  keepAliveIntervalSeconds: number;
  /** table to store PubSub subscription info in */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
  /** table where subscriptions are stored. Needed to cleanup after connections */
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>;
}): IConnectionListener => {
  // Return date of when we should consider the connection expired because of inactivity.
  // now + (2 * keepAliveIntervalSeconds)
  const getNextExpiresAt = (): Date => {
    const d = new Date();
    d.setSeconds(d.getSeconds() + 2 * options.keepAliveIntervalSeconds);
    return d;
  };
  // Return a date of when we should next delay connection expiration.
  // It's now + keepAliveIntervalSeconds
  const getNextExpirationDelayAt = (): Date => {
    const d = new Date();
    d.setSeconds(d.getSeconds() + options.keepAliveIntervalSeconds);
    return d;
  };
  const metaConnectionExpirationDelayAt = "Meta-Connection-Expiration-Delay-At";
  /** Return HTTP response header key/value that will delay the connection expiration */
  const delayExpirationDelayResponseHeaders = (): Record<string, string> => {
    return {
      [`Set-${metaConnectionExpirationDelayAt}`]: getNextExpirationDelayAt().toISOString(),
    };
  };
  // cleanup after the connection once it is closed or disconnected
  const cleanupConnection = async () => {
    await cleanupStorageAfterConnection({
      connection: { id: options.connection.id },
      connectionStorage: options.connectionStorage,
      pubSubSubscriptionStorage: options.pubSubSubscriptionStorage,
      subscriptionStorage: options.subscriptionStorage,
    });
  };
  return {
    async onClose() {
      await cleanupConnection();
    },
    async onDisconnect() {
      await cleanupConnection();
    },
    /** On connection open, store the connection */
    async onOpen() {
      await options.connectionStorage.insert({
        createdAt: new Date().toISOString(),
        expiresAt: getNextExpiresAt().toISOString(),
        id: options.connection.id,
      });
      return {
        headers: {
          ...delayExpirationDelayResponseHeaders(),
        },
      };
    },
    /** On every WebSocket-Over-HTTP request, check if it's time to delay expiration of the connection and, if so, update the connection.expiresAt in connectionStorage */
    async onHttpRequest(request) {
      const delayExpirationAtHeaderValue =
        request.headers[metaConnectionExpirationDelayAt.toLowerCase()];
      const delayExpirationAtISOString = Array.isArray(
        delayExpirationAtHeaderValue,
      )
        ? delayExpirationAtHeaderValue[0]
        : delayExpirationAtHeaderValue;
      if (!delayExpirationAtISOString) {
        // This is probably the connection open request, in which case we just created the connection. We don't need to refresh it
        return;
      }
      const delayExpirationAtDate = new Date(
        Date.parse(delayExpirationAtISOString),
      );
      if (new Date() < delayExpirationAtDate) {
        // we don't need to delay expiration yet.
        return;
      }
      const storedConnection = await options.connectionStorage.get({
        id: options.connection.id,
      });
      if (!storedConnection) {
        console.warn(
          `Got WebSocket-Over-Http request with ${metaConnectionExpirationDelayAt}, but there is no corresponding stored connection. This should only happen if the connection has been deleted some other way. Returning DISCONNECT message to tell the gateway that this connection should be forgotten.`,
        );
        options.connection.webSocketContext.outEvents.push(
          new WebSocketEvent("DISCONNECT"),
        );
        return;
      }
      // update expiration date of connection in storage
      await options.connectionStorage.update(
        { id: options.connection.id },
        {
          expiresAt: getNextExpiresAt().toISOString(),
        },
      );
      // And update the ws-over-http state management to push out the next time we need to delay expiration
      return {
        headers: {
          ...delayExpirationDelayResponseHeaders(),
        },
      };
    },
  };
};

interface IGraphqlWsOverWebSocketOverHttpExpressMiddlewareOptions {
  /** table to store information about each ws-over-http connection */
  connectionStorage: ISimpleTable<IStoredConnection>;
  /** table to store PubSub subscription info in */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
  /** graphql schema */
  schema: graphql.GraphQLSchema;
  /** table to store information about each Graphql Subscription */
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>;
  /** WebSocket-Over-HTTP options */
  webSocketOverHttp?: {
    /** how often to ask ws-over-http gateway to make keepalive requests */
    keepAliveIntervalSeconds?: number;
  };
  /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
  getGripChannel(gqlStartMessage: IGraphqlWsStartMessage): string;
  /** Called when a new subscrpition connection is made */
  onSubscriptionStart?(...args: any[]): any;
  /** Called when a subscription is stopped */
  onSubscriptionStop?(...args: any[]): any;
}

/**
 * Create an Express Middleware that will accept graphql-ws connections that come in over WebSocket-Over-Http
 */
export const GraphqlWsOverWebSocketOverHttpExpressMiddleware = (
  options: IGraphqlWsOverWebSocketOverHttpExpressMiddlewareOptions,
): express.RequestHandler => {
  const { connectionStorage } = options;
  const { keepAliveIntervalSeconds = 120 } = options.webSocketOverHttp || {};
  return WebSocketOverHttpExpress({
    getConnectionListener(connection) {
      /** This connectionListener will respond to graphql-ws messages in a way that accepts all incoming subscriptions */
      const graphqlWsConnectionListener = GraphqlWebSocketOverHttpConnectionListener(
        {
          cleanupConnection: SubscriptionStorageConnectionCleanup(
            options.subscriptionStorage,
          ),
          connection,
          getMessageResponse: AcceptAllGraphqlSubscriptionsMessageHandler(),
          webSocketOverHttp: {
            keepAliveIntervalSeconds,
            ...options.webSocketOverHttp,
          },
          async getGripChannels(channelSelector): Promise<string[]> {
            const startMessages: IGraphqlWsStartMessage[] = await (async (): Promise<
              IGraphqlWsStartMessage[]
            > => {
              if (isGraphqlWsStartMessage(channelSelector)) {
                return [channelSelector];
              }
              if ("connection" in channelSelector) {
                // look up by connectionId
                const subscriptionsForConnection = await filterTable(
                  options.subscriptionStorage,
                  subscription =>
                    subscription.connectionId === channelSelector.connection.id,
                );
                return await Promise.all(
                  subscriptionsForConnection.map(s => {
                    const startMessage = JSON.parse(s.startMessage);
                    return startMessage;
                  }),
                );
              }
              if (isGraphqlWsStopMessage(channelSelector)) {
                const stopMessage: IGraphqlWsStopMessage = channelSelector;
                // Look up the graphql-ws start message corresponding to this stop message from the subscriptionStorage
                const storedSubscriptionsForStopMessage = await filterTable(
                  options.subscriptionStorage,
                  s => {
                    return (
                      s.operationId === stopMessage.id &&
                      s.connectionId === connection.id
                    );
                  },
                );
                return await Promise.all(
                  storedSubscriptionsForStopMessage.map(s => {
                    const startMessage = JSON.parse(s.startMessage);
                    return startMessage;
                  }),
                );
              }
              assertNever(channelSelector);
              throw new Error(
                `Failed to retrieve gripChannels for channelSelector ${channelSelector}`,
              );
            })();
            const gripChannels = startMessages.map(options.getGripChannel);
            return gripChannels;
          },
        },
      );
      const { subscriptionStorage } = options;
      /**
       * We also want to keep track of all subscriptions in a table so we can look them up later when publishing.
       * So this message handler will watch for graphql-ws GQL_START mesages and store subscription info based on them
       */
      const storeSubscriptionsMessageHandler = SubscriptionStoringMessageHandler(
        { connection, subscriptionStorage },
      );
      /** And a handler that will delete stored subscriptions when there are Stopped */
      const deleteSubscriptionsOnStopMessageHandler = SubscriptionDeletingMessageHandler(
        { connection, subscriptionStorage },
      );
      const subscriptionEventCallbacksConnectionListener: IConnectionListener = {
        onMessage: composeMessageHandlers([
          // We want this at the end so we can rely on onSubscriptionStop being called after subscriptionStorage has been updated
          GraphqlWsStartMessageHandler(async () => {
            if (options.onSubscriptionStart) {
              options.onSubscriptionStart();
            }
          }),
          // We want this at the end so we can rely on onSubscriptionStop being called after subscriptionStorage has been updated
          GraphqlWsStopMessageHandler(async () => {
            if (options.onSubscriptionStop) {
              options.onSubscriptionStop();
            }
          }),
        ]),
      };
      /**
       * Returned onMessage is going to be a composition of the above message handlers.
       * Note that storeSubscriptions happens at the beginning, and deleteSubscriptionsOnStop happens at the end.
       * This way any message handlers in the middle can count on the stored subscription being in storage.
       */
      return ComposedConnectionListener([
        ConnectionStoringConnectionListener({
          connection,
          connectionStorage,
          keepAliveIntervalSeconds,
          pubSubSubscriptionStorage: options.pubSubSubscriptionStorage,
          subscriptionStorage,
        }),
        {
          onMessage: ExecuteGraphqlWsSubscriptionsMessageHandler({
            ...options,
            webSocketOverHttp: { connection },
          }),
        },
        { onMessage: storeSubscriptionsMessageHandler },
        graphqlWsConnectionListener,
        { onMessage: deleteSubscriptionsOnStopMessageHandler },
        subscriptionEventCallbacksConnectionListener,
      ]);
    },
  });
};

export default GraphqlWsOverWebSocketOverHttpExpressMiddleware;
