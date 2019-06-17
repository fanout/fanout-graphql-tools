import * as express from "express";
import * as http from "http";
import { ISimpleTable } from "../simple-table/SimpleTable";
import { IGraphqlSubscription } from "./GraphqlSubscription";
import { IGraphqlWsStartMessage } from "./GraphqlWebSocketOverHttpConnectionListener";
import GraphqlWsOverWebSocketOverHttpExpressMiddleware, {
  IStoredConnection,
} from "./GraphqlWsOverWebSocketOverHttpExpressMiddleware";

interface IGraphqlWsOverWebSocketOverHttpRequestListenerOptions {
  /** table to store information about each ws-over-http connection */
  connectionStorage: ISimpleTable<IStoredConnection>;
  /** table to store information about each Graphql Subscription */
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>;
  /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
  getGripChannel(gqlStartMessage: IGraphqlWsStartMessage): string;
}

/**
 * GraphqlWsOverWebSocketOverHttpRequestListener.
 * Given an http RequestListener, return a new one that will respond to incoming WebSocket-Over-Http requests that are graphql-ws
 * Subscriptions and accept the subscriptions.
 */
export const GraphqlWsOverWebSocketOverHttpRequestListener = (
  originalRequestListener: http.RequestListener,
  options: IGraphqlWsOverWebSocketOverHttpRequestListenerOptions,
): http.RequestListener => (req, res) => {
  const handleWebSocketOverHttpRequestHandler: http.RequestListener = express()
    .use(GraphqlWsOverWebSocketOverHttpExpressMiddleware(options))
    .use((expressRequest, expressResponse) => {
      // It wasn't handled by GraphqlWsOverWebSocketOverHttpExpressMiddleware
      originalRequestListener(req, res);
    });
  handleWebSocketOverHttpRequestHandler(req, res);
};
