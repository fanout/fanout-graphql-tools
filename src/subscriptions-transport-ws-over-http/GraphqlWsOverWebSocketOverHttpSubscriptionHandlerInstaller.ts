import * as express from "express";
import { GraphQLSchema } from "graphql";
import * as http from "http";
import { ISimpleTable } from "../simple-table/SimpleTable";
import { IGraphqlWsStartMessage } from "./GraphqlWebSocketOverHttpConnectionListener";
import { GraphqlWsGripChannelNamer } from "./GraphqlWsGripChannelNamers";
import GraphqlWsOverWebSocketOverHttpExpressMiddleware, {
  IStoredConnection,
} from "./GraphqlWsOverWebSocketOverHttpExpressMiddleware";
import { IStoredPubSubSubscription } from "./PubSubSubscriptionStorage";

interface IGraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstallerOptions {
  /** table to store information about each ws-over-http connection */
  connectionStorage: ISimpleTable<IStoredConnection>;
  /** table to store PubSub subscription info in */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
  /** GraphQL Schema including resolvers */
  schema: GraphQLSchema;
  /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
  getGripChannel?: GraphqlWsGripChannelNamer;
}

/**
 * Create a function that will patch an http.Server instance such that it responds to incoming graphql-ws over WebSocket-Over-Http requests in a way that will allow all GraphQL Subscriptions to initiate.
 * If the incoming request is not of this specific kind, it will be handled however the http.Server normally would.
 */
export const GraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstaller = (
  options: IGraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstallerOptions,
) => (httpServer: http.Server) => {
  interceptRequests(httpServer, (request, response, next) => {
    const handleWebSocketOverHttpRequestHandler: http.RequestListener = express()
      .use(GraphqlWsOverWebSocketOverHttpExpressMiddleware(options))
      .use((expressRequest, expressResponse) => {
        // It wasn't handled by GraphqlWsOverWebSocketOverHttpExpressMiddleware
        next();
      });
    handleWebSocketOverHttpRequestHandler(request, response);
  });
};

type AnyFunction = (...args: any[]) => any;

/** NodeJS.EventEmitter properties that do exist but are not documented and aren't on the TypeScript types */
interface IEventEmitterPrivates {
  /** Internal state holding refs to all listeners */
  _events: Record<string, AnyFunction | AnyFunction[] | undefined>;
}
/** Use declaration merigng to add IEventEmitterPrivates to NodeJs.EventEmitters like http.Server used below */
declare module "events" {
  // EventEmitter
  // tslint:disable-next-line:interface-name no-empty-interface
  interface EventEmitter extends IEventEmitterPrivates {}
}

type RequestInterceptor = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  next: () => void,
) => void;

/** Patch an httpServer to pass all incoming requests through an interceptor before doing what it would normally do */
function interceptRequests(
  httpServer: http.Server,
  intercept: RequestInterceptor,
) {
  const originalRequestListeners = httpServer._events.request;
  httpServer._events.request = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => {
    intercept(request, response, () => {
      const listeners = originalRequestListeners
        ? Array.isArray(originalRequestListeners)
          ? originalRequestListeners
          : [originalRequestListeners]
        : [];
      listeners.forEach(listener => listener(request, response));
    });
  };
}
