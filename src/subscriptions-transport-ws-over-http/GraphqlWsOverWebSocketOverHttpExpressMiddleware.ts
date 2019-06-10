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
  if (!graphqlWsEvent) {
    return;
  }
  const operationId = graphqlWsEvent.id;
  switch (graphqlWsEvent.type) {
    case "stop":
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
      break;
    case "start":
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
      break;
  }
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
          getGripChannel: options.getGripChannel,
          getMessageResponse: AcceptAllGraphqlSubscriptionsMessageHandler({
            onStart: options.onSubscriptionStart,
            onStop: options.onSubscriptionStop,
          }),
        },
      );
      /**
       * We also want to keep track of all subscriptions in a table so we can look them up later when publishing.
       * So this message handler will watch for graphql-ws GQL_START mesages and store subscription info based on them
       */
      const storeSubscriptionsOnMessage = SubscriptionStoringMessageHandler({
        connection,
        subscriptionStorage: options.subscriptionStorage,
      });
      // So the returned onMessage is going to be a composition of the above message handlers
      const onMessage = composeMessageHandlers([
        storeSubscriptionsOnMessage,
        graphqlWsConnectionListener.onMessage,
      ]);
      return {
        ...graphqlWsConnectionListener,
        onMessage,
      };
    },
  });
};

export default GraphqlWsOverWebSocketOverHttpExpressMiddleware;
