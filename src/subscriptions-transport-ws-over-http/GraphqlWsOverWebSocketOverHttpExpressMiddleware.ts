import * as assert from "assert";
import * as express from "express";
import { v4 as uuidv4 } from "uuid";
import { default as AcceptAllGraphqlSubscriptionsMessageHandler } from "../graphql-ws/AcceptAllGraphqlSubscriptionsMessageHandler";
import { filterTable, ISimpleTable } from "../simple-table/SimpleTable";
import WebSocketOverHttpExpress from "../websocket-over-http-express/WebSocketOverHttpExpress";
import { IGraphqlSubscription } from "./GraphqlSubscription";
import GraphqlWebSocketOverHttpConnectionListener, {
  getSubscriptionOperationFieldName,
  IConnectionListener,
  IGraphqlWsStartMessage,
  IGraphqlWsStopMessage,
  isGraphqlWsStartMessage,
  isGraphqlWsStopMessage,
} from "./GraphqlWebSocketOverHttpConnectionListener";

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

type IMessageListener = IConnectionListener["onMessage"];
const composeMessageHandlers = (
  handlers: IMessageListener[],
): IMessageListener => {
  const composedMessageHandler = async (message: string) => {
    const responses = [];
    for (const handler of handlers) {
      responses.push(await handler(message));
    }
    return responses.filter(Boolean).join("\n");
  };
  return composedMessageHandler;
};

interface IGraphqlWsOverWebSocketOverHttpExpressMiddlewareOptions {
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
  return WebSocketOverHttpExpress({
    getConnectionListener(connection) {
      /** This connectionListener will respond to graphql-ws messages in a way that accepts all incoming subscriptions */
      const graphqlWsConnectionListener = GraphqlWebSocketOverHttpConnectionListener(
        {
          connection,
          getMessageResponse: AcceptAllGraphqlSubscriptionsMessageHandler(),
          webSocketOverHttp: {
            keepAliveIntervalSeconds: 120,
            ...options.webSocketOverHttp,
          },
          async getGripChannel(graphqlWsMessage) {
            const startMessage: IGraphqlWsStartMessage = isGraphqlWsStartMessage(
              graphqlWsMessage,
            )
              ? graphqlWsMessage
              : await (async () => {
                  const stopMessage: IGraphqlWsStopMessage = graphqlWsMessage;
                  const allStoredSubscriptions = await options.subscriptionStorage.scan();
                  // Look up the graphql-ws start message corresponding to this stop message from the subscriptionStorage
                  const storedSubscriptions = await filterTable(
                    options.subscriptionStorage,
                    s => {
                      return (
                        s.operationId === stopMessage.id &&
                        s.connectionId === connection.id
                      );
                    },
                  );
                  const storedSubscription = await (async () => {
                    switch (storedSubscriptions.length) {
                      case 0:
                        return;
                      case 1:
                        return storedSubscriptions[0];
                      default:
                        // @TODO getGripChannel should support returning an array of channels
                        console.warn(
                          `Found multiple stored subscriptions matching GQL_STOP. Expected only one. Will only use the first.`,
                        );
                        return storedSubscriptions[0];
                    }
                  })();
                  if (storedSubscription) {
                    const parsedStartMessage = JSON.parse(
                      storedSubscription.startMessage,
                    );
                    if (!isGraphqlWsStartMessage(parsedStartMessage)) {
                      throw new Error(
                        `Failed to parse IGraphqlWsStartMessage from subscription.startMessage: ${storedSubscription}`,
                      );
                    }
                    return parsedStartMessage;
                  }
                  throw new Error(
                    `Failed to retrieve IGraphqlWsStartMessage for graphql-ws stop message: ${stopMessage}`,
                  );
                })();
            const gripChannel = options.getGripChannel(startMessage);
            return gripChannel;
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
      /**
       * Returned onMessage is going to be a composition of the above message handlers.
       * Note that storeSubscriptions happens at the beginning, and deleteSubscriptionsOnStop happens at the end.
       * This way any message handlers in the middle can count on the stored subscription being in storage.
       */
      const onMessage = composeMessageHandlers([
        storeSubscriptionsMessageHandler,
        graphqlWsConnectionListener.onMessage,
        deleteSubscriptionsOnStopMessageHandler,
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
      ]);
      return {
        ...graphqlWsConnectionListener,
        onMessage,
      };
    },
  });
};

export default GraphqlWsOverWebSocketOverHttpExpressMiddleware;
