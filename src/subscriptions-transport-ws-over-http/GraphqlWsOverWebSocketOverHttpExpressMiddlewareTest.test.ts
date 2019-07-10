import {
  AsyncTest,
  Expect,
  FocusTest,
  IgnoreTest,
  TestFixture,
} from "alsatian";
import { NormalizedCacheObject } from "apollo-cache-inmemory";
import ApolloClient from "apollo-client";
import { ApolloServer } from "apollo-server-express";
import {
  buildSchemaFromTypeDefinitions,
  IResolvers,
  makeExecutableSchema,
  PubSub,
  PubSubEngine,
} from "apollo-server-express";
import * as express from "express";
import { DocumentNode } from "graphql";
import * as http from "http";
import * as urlModule from "url";
import {
  SimpleGraphqlApi,
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
import { IGraphqlWsStartMessage } from "./GraphqlWebSocketOverHttpConnectionListener";
import GraphqlWsOverWebSocketOverHttpExpressMiddleware, {
  IStoredConnection,
} from "./GraphqlWsOverWebSocketOverHttpExpressMiddleware";
import { GraphqlWsOverWebSocketOverHttpStorageCleaner } from "./GraphqlWsOverWebSocketOverHttpStorageCleaner";
import { IStoredPubSubSubscription } from "./PubSubSubscriptionStorage";
import { WebSocketOverHttpContextFunction } from "./WebSocketOverHttpGraphqlContext";

interface ISubscriptionsListener {
  /** called on subscription start */
  onConnect: (...args: any[]) => void;
}

interface IGraphqlHttpAppOptions {
  /** table to store information about each ws-over-http connection */
  connectionStorage: ISimpleTable<IStoredConnection>;
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
  /** table that will store information about PubSubEngine subscriptions */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
  /** Object that will be called base on subscription connect/disconnect */
  subscriptionListener?: ISubscriptionsListener;
  /** configure WebSocket-Over-Http */
  webSocketOverHttp: {
    /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
    getGripChannel(gqlStartMessage: IGraphqlWsStartMessage): string;
  };
}

const WsOverHttpGraphqlHttpApp = (options: IGraphqlHttpAppOptions) => {
  const { subscriptionListener } = options;
  const pubsub = new PubSub();
  const resolvers = options.graphql.getResolvers({ pubsub });
  const schema = makeExecutableSchema({
    resolvers,
    typeDefs: options.graphql.typeDefs,
  });
  const expressApplication = express().use(
    GraphqlWsOverWebSocketOverHttpExpressMiddleware({
      connectionStorage: options.connectionStorage,
      getGripChannel: options.webSocketOverHttp.getGripChannel,
      onSubscriptionStart:
        subscriptionListener && subscriptionListener.onConnect,
      pubSubSubscriptionStorage: options.pubSubSubscriptionStorage,
      schema,
    }),
  );
  const graphqlPath = "/";
  const subscriptionsPath = "/";
  const apolloServer = new ApolloServer({
    context: WebSocketOverHttpContextFunction({
      grip: {
        getGripChannel: options.webSocketOverHttp.getGripChannel,
        url: process.env.GRIP_URL || "http://localhost:5561",
      },
      pubSubSubscriptionStorage: options.pubSubSubscriptionStorage,
      schema,
    }),
    resolvers,
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
    const pubSubSubscriptionStorage = MapSimpleTable<
      IStoredPubSubSubscription
    >();
    const graphqlSchema = buildSchemaFromTypeDefinitions(
      SimpleGraphqlApi().typeDefs,
    );
    const app = WsOverHttpGraphqlHttpApp({
      connectionStorage: MapSimpleTable<IStoredConnection>(),
      graphql: {
        getResolvers: ({ pubsub }) => SimpleGraphqlApi({ pubsub }).resolvers,
        typeDefs: SimpleGraphqlApi().typeDefs,
      },
      pubSubSubscriptionStorage,
      subscriptionListener: { onConnect: onSubscriptionConnection },
      webSocketOverHttp: {
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
   * This requires that pushpin be running and have /etc/pushpin/routes configured to route traffic to serverPort, e.g. "*,debug localhost:57410,over_http".
   * If pushpin is running, the default value of PUSHPIN_PROXY_URL=http://localhost:7999
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
    const connectionStorage = MapSimpleTable<IStoredConnection>();
    const pubSubSubscriptionStorage = MapSimpleTable<
      IStoredPubSubSubscription
    >();
    const app = WsOverHttpGraphqlHttpApp({
      connectionStorage,
      graphql: {
        getResolvers: ({ pubsub }) => SimpleGraphqlApi({ pubsub }).resolvers,
        typeDefs: SimpleGraphqlApi().typeDefs,
      },
      pubSubSubscriptionStorage,
      subscriptionListener: { onConnect: onSubscriptionConnection },
      webSocketOverHttp: {
        getGripChannel: SimpleGraphqlApiGripChannelNamer(),
      },
    });
    await withListeningServer(app.httpServer, serverPort)(async ({ url }) => {
      const urls = {
        subscriptionsUrl: urlWithPath(pushpinProxyUrl, app.subscriptionsPath),
        url: urlWithPath(pushpinProxyUrl, app.graphqlPath),
      };
      const createApolloClient = () => WebSocketApolloClient(urls);
      const apolloClient = createApolloClient();
      const { items, subscription } = itemsFromLinkObservable(
        apolloClient.subscribe(SimpleGraphqlApiSubscriptions.postAdded()),
      );
      await latestSubscriptionChanged();
      // Check that the subscription resulted in storing info about the subscription and also the graphql-ws connection it was sent over
      const storedConnectionsAfterSubscription = await connectionStorage.scan();
      Expect(storedConnectionsAfterSubscription.length).toEqual(1);
      const storedPubSubSubscriptionsAfterSubscription = await pubSubSubscriptionStorage.scan();
      Expect(storedPubSubSubscriptionsAfterSubscription.length).toEqual(1);

      // Now let's make a mutation that should result in a message coming from the subscription
      const postToAdd = {
        author: "me",
        comment: "first!",
      };
      const mutationResult = await apolloClient.mutate(
        SimpleGraphqlApiMutations.addPost(postToAdd),
      );
      Expect(mutationResult.data.addPost.comment).toEqual(postToAdd.comment);
      await timer(500);
      Expect(items.length).toEqual(1);
      const firstPostAddedMessage = items[0];
      Expect(firstPostAddedMessage.data.postAdded.comment).toEqual(
        postToAdd.comment,
      );

      // Now we want to make sure it's possible to clean up records from storage once they have expired due to inactivity
      const cleanUpStorage = GraphqlWsOverWebSocketOverHttpStorageCleaner({
        connectionStorage,
        pubSubSubscriptionStorage,
      });
      // first try a cleanup right now. Right after creating the connection and subscription. It should not result in any deleted rows because it's too soon. They haven't expired yet.
      const afterEarlyCleanup = {
        connections: await connectionStorage.scan(),
        pubSubSubscriptions: await pubSubSubscriptionStorage.scan(),
      };
      Expect(afterEarlyCleanup.pubSubSubscriptions.length).toEqual(1);
      Expect(afterEarlyCleanup.connections.length).toEqual(1);

      // Five minutes from now - At this point they should be expired
      const simulateCleanupAtDate = (() => {
        return new Date(
          Date.parse(afterEarlyCleanup.connections[0].expiresAt) + 1000,
        );
      })();
      await cleanUpStorage(simulateCleanupAtDate);
      const afterCleanup = {
        connections: await connectionStorage.scan(),
        pubSubSubscriptions: await pubSubSubscriptionStorage.scan(),
      };
      Expect(afterCleanup.pubSubSubscriptions.length).toEqual(0);
      Expect(afterCleanup.connections.length).toEqual(0);

      await testMultipleGraphqlSubscriptions(
        createApolloClient,
        latestSubscriptionChanged,
      );
    });
    return;
  }
}

/**
 * There was a bug that would manifest like so:
 * * create a graphql-ws subscription (through pushpin/GRIP) using N>=2 clients. Identical subscriptions (e.g. two tabs in graphiql playground)
 * * send a mutation that should result in a message on the subscriptions
 * * You expect each client to receive 1 message from the mutation, but actually they will receive N.
 * This was because, while they were all independent clients/subscriptions, they all end up reusing the same Grip-Channel. So we only need to publish one message via EPCP to that Grip-Channel, not N messages, one per subscription.
 * This tests that this bug is fixed.
 */
async function testMultipleGraphqlSubscriptions(
  // It's assumed this is properly configured to talk to a listening graphql API through pushpin that is running the 'SimpleGraphqlAPI' typeDefs/resolvers
  createApolloClient: () => ApolloClient<NormalizedCacheObject>,
  // call this to get a promise for when a new subscription is fully handled by the server
  latestSubscriptionChanged: () => Promise<any>,
): Promise<void> {
  // we need separate apollo clients because we want the graphql-ws start messages that come in to be exactly equivalent, including the operationId.
  // If we use the same client, it auto-increments the operationId and the bug would not happen.
  const apolloClient1 = createApolloClient();
  const firstSubscriptionListener = itemsFromLinkObservable(
    apolloClient1.subscribe(SimpleGraphqlApiSubscriptions.postAdded()),
  );
  await latestSubscriptionChanged();

  const apolloClient2 = createApolloClient();
  const secondSubscriptionListener = itemsFromLinkObservable(
    apolloClient2.subscribe(SimpleGraphqlApiSubscriptions.postAdded()),
  );
  await latestSubscriptionChanged();

  await apolloClient1.mutate(
    SimpleGraphqlApiMutations.addPost({ author: "me", comment: "hello" }),
  );
  await timer(500);
  Expect(firstSubscriptionListener.items.length).toEqual(1);
  Expect(secondSubscriptionListener.items.length).toEqual(1);
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

/** return promise that resolves after some milliseconds */
export function timer(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
