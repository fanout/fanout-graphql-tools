import {
  AsyncTest,
  Expect,
  FocusTest,
  IgnoreTest,
  TestCase,
  TestFixture,
  Timeout,
} from "alsatian";
import {
  buildSchemaFromTypeDefinitions,
  IResolvers,
  PubSub,
  PubSubEngine,
} from "apollo-server-express";
import { ApolloServer } from "apollo-server-express";
import * as express from "express";
import { DocumentNode } from "graphql";
import gql from "graphql-tag";
import * as http from "http";
import * as urlModule from "url";
import {
  EpcpPubSubMixin,
  IEpcpPublish,
  IPubSubEnginePublish,
} from "../graphql-epcp-pubsub/EpcpPubSubMixin";
import {
  SimpleGraphqlApi,
  SimpleGraphqlApiEpcpPublisher,
  SimpleGraphqlApiGripChannelNamer,
  SimpleGraphqlApiMutations,
  SimpleGraphqlApiSubscriptions,
} from "../simple-graphql-api/SimpleGraphqlApi";
import { ISimpleTable, MapSimpleTable } from "../simple-table/SimpleTable";
import { cli } from "../test/cli";
import { ChangingValue } from "../testing-tools/ChangingValue";
import { itemsFromLinkObservable } from "../testing-tools/itemsFromLinkObservable";
import WebSocketApolloClient from "../testing-tools/WebSocketApolloClient";
import { withListeningServer } from "../testing-tools/withListeningServer";
import { IGraphqlSubscription } from "./GraphqlSubscription";
import { IGraphqlWsStartMessage } from "./GraphqlWebSocketOverHttpConnectionListener";
import GraphqlWsOverWebSocketOverHttpExpressMiddleware from "./GraphqlWsOverWebSocketOverHttpExpressMiddleware";

interface ISubscriptionsListener {
  /** called on subscription start */
  onConnect: (...args: any[]) => void;
}

interface IGraphqlHttpAppOptions {
  /** configure graphql API */
  graphql: {
    /** GraphQL API typeDefs */
    typeDefs: DocumentNode;
    /** get resolvers for GraphQL API */
    getResolvers(options: {
      /** PubSubEngine to use in resolvers */
      pubsub: PubSubEngine;
    }): IResolvers;
  };
  /** Object that will be called base on subscription connect/disconnect */
  subscriptionListener?: ISubscriptionsListener;
  /** table in which to store graphql-ws Subscriptions */
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>;
  /** configure WebSocket-Over-Http */
  webSocketOverHttp: {
    /** Given a PubSubEngine publish invocation, return instructions for what to publish to a GRIP server via EPCP */
    epcpPublishForPubSubEnginePublish(
      publish: IPubSubEnginePublish,
    ): Promise<IEpcpPublish[]>;
    /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
    getGripChannel(gqlStartMessage: IGraphqlWsStartMessage): string;
  };
}

const WsOverHttpGraphqlHttpApp = (options: IGraphqlHttpAppOptions) => {
  const { subscriptionListener } = options;
  const schema = buildSchemaFromTypeDefinitions(options.graphql.typeDefs);
  const pubsub = EpcpPubSubMixin({
    epcpPublishForPubSubEnginePublish:
      options.webSocketOverHttp.epcpPublishForPubSubEnginePublish,
    grip: {
      url: process.env.GRIP_URL || "http://localhost:5561",
    },
    schema,
  })(new PubSub());
  const expressApplication = express().use(
    GraphqlWsOverWebSocketOverHttpExpressMiddleware({
      getGripChannel: options.webSocketOverHttp.getGripChannel,
      onSubscriptionStart:
        subscriptionListener && subscriptionListener.onConnect,
      subscriptionStorage: options.subscriptionStorage,
    }),
  );
  const graphqlPath = "/";
  const subscriptionsPath = "/";
  const apolloServer = new ApolloServer({
    resolvers: options.graphql.getResolvers({ pubsub }),
    subscriptions: {
      onConnect: subscriptionListener && subscriptionListener.onConnect,
      path: subscriptionsPath,
    },
    typeDefs: options.graphql.typeDefs,
  });
  apolloServer.applyMiddleware({
    app: expressApplication,
    path: graphqlPath,
  });
  const httpServer = http.createServer(expressApplication);
  apolloServer.installSubscriptionHandlers(httpServer);
  return { apolloServer, graphqlPath, httpServer, subscriptionsPath };
};

/** Given a base URL and a Path, return a new URL with that path on the baseUrl (existing path on baseUrl is ignored) */
const urlWithPath = (baseUrl: string, pathname: string): string => {
  const parsedBaseUrl = urlModule.parse(baseUrl);
  const newUrl = urlModule.format({ ...parsedBaseUrl, pathname });
  return newUrl;
};

/** Test ./GraphqlWsOverWebSocketOverHttpExpressMiddleware */
@TestFixture()
export class GraphqlWsOverWebSocketOverHttpExpressMiddlewareTest {
  /** test we can make a server and connect to it */
  @AsyncTest()
  public async testSimpleGraphqlServerWithApolloClient() {
    const [
      onSubscriptionConnection,
      _,
      latestSubscriptionChanged,
    ] = ChangingValue();
    const subscriptionStorage = MapSimpleTable<IGraphqlSubscription>();
    const graphqlSchema = buildSchemaFromTypeDefinitions(
      SimpleGraphqlApi().typeDefs,
    );
    const app = WsOverHttpGraphqlHttpApp({
      graphql: {
        getResolvers: ({ pubsub }) => SimpleGraphqlApi({ pubsub }).resolvers,
        typeDefs: SimpleGraphqlApi().typeDefs,
      },
      subscriptionListener: { onConnect: onSubscriptionConnection },
      subscriptionStorage,
      webSocketOverHttp: {
        epcpPublishForPubSubEnginePublish: SimpleGraphqlApiEpcpPublisher({
          graphqlSchema,
          subscriptionStorage,
        }),
        getGripChannel: SimpleGraphqlApiGripChannelNamer(),
      },
    });
    await withListeningServer(app.httpServer, 0)(async ({ url }) => {
      const urls = {
        subscriptionsUrl: urlWithPath(url, app.subscriptionsPath),
        url: urlWithPath(url, app.graphqlPath),
      };
      const apolloClient = WebSocketApolloClient(urls);
      const { items, subscription } = itemsFromLinkObservable(
        apolloClient.subscribe(SimpleGraphqlApiSubscriptions.postAdded()),
      );
      await latestSubscriptionChanged();
      const postToAdd = {
        author: "me",
        comment: "first!",
      };
      const mutationResult = await apolloClient.mutate(
        SimpleGraphqlApiMutations.addPost(postToAdd),
      );
      Expect(mutationResult.data.addPost.comment).toEqual(postToAdd.comment);
      Expect(items.length).toEqual(1);
    });
    return;
  }
  /**
   * test we can make a server and connect to it through pushpin.
   * This requires that pushpin be running and have /etc/pushpin/routes configured to route traffic to serverPort, e.g. "*,debug localhost:57410,over_http"
   */
  @DecorateIf(
    () => !Boolean(process.env.PUSHPIN_PROXY_URL),
    IgnoreTest("process.env.PUSHPIN_PROXY_URL is not defined"),
  )
  @AsyncTest()
  public async testSimpleGraphqlServerWithApolloClientThroughPushpin(
    serverPort = 57410,
    pushpinProxyUrl = process.env.PUSHPIN_PROXY_URL,
    pushpinGripUrl = "http://localhost:5561",
  ) {
    if (!pushpinProxyUrl) {
      throw new Error(`pushpinProxyUrl is required`);
    }
    const [
      onSubscriptionConnection,
      _,
      latestSubscriptionChanged,
    ] = ChangingValue();
    const subscriptionStorage = MapSimpleTable<IGraphqlSubscription>();
    const graphqlSchema = buildSchemaFromTypeDefinitions(
      SimpleGraphqlApi().typeDefs,
    );
    const app = WsOverHttpGraphqlHttpApp({
      graphql: {
        getResolvers: ({ pubsub }) => SimpleGraphqlApi({ pubsub }).resolvers,
        typeDefs: SimpleGraphqlApi().typeDefs,
      },
      subscriptionListener: { onConnect: onSubscriptionConnection },
      subscriptionStorage,
      webSocketOverHttp: {
        epcpPublishForPubSubEnginePublish: SimpleGraphqlApiEpcpPublisher({
          graphqlSchema,
          subscriptionStorage,
        }),
        getGripChannel: SimpleGraphqlApiGripChannelNamer(),
      },
    });
    await withListeningServer(app.httpServer, serverPort)(async ({ url }) => {
      const urls = {
        subscriptionsUrl: urlWithPath(pushpinProxyUrl, app.subscriptionsPath),
        url: urlWithPath(pushpinProxyUrl, app.graphqlPath),
      };
      const apolloClient = WebSocketApolloClient(urls);
      const { items, subscription } = itemsFromLinkObservable(
        apolloClient.subscribe(SimpleGraphqlApiSubscriptions.postAdded()),
      );
      await latestSubscriptionChanged();
      const postToAdd = {
        author: "me",
        comment: "first!",
      };
      const mutationResult = await apolloClient.mutate(
        SimpleGraphqlApiMutations.addPost(postToAdd),
      );
      Expect(mutationResult.data.addPost.comment).toEqual(postToAdd.comment);
      Expect(items.length).toEqual(1);
      const firstPostAddedMessage = items[0];
      Expect(firstPostAddedMessage.data.postAdded.comment).toEqual(
        postToAdd.comment,
      );
    });
    return;
  }
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}

type Decorator = (
  target: object,
  propertyKey: string,
  descriptor?: TypedPropertyDescriptor<any>,
) => void;
/** Conditionally apply a decorator */
function DecorateIf(test: () => boolean, decorator: Decorator): Decorator {
  if (test()) {
    return decorator;
  }
  return () => {
    return;
  };
}
