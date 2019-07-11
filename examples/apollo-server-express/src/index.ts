import { ApolloServer, makeExecutableSchema } from "apollo-server-express";
import * as express from "express";
import { IStoredConnection, IStoredPubSubSubscription } from "fanout-graphql-tools";
import { GraphqlWsOverWebSocketOverHttpExpressMiddleware } from "fanout-graphql-tools";
import { MapSimpleTable } from "fanout-graphql-tools";
import { WebSocketOverHttpContextFunction } from "fanout-graphql-tools";
import * as http from "http";
import { SimpleGraphqlApi } from "../../../src/simple-graphql-api/SimpleGraphqlApi";

/**
 * WebSocket-Over-HTTP Support requires storage to keep track of ws-over-http connections and subscriptions.
 * The Storage objects match an ISimpleTable interface that is a subset of the @pulumi/cloud Table interface. MapSimpleTable is an in-memory implementation, but you can use @pulumi/cloud implementations in production, e.g. to use DyanmoDB.
 */
const connectionStorage = MapSimpleTable<IStoredConnection>();
const pubSubSubscriptionStorage = MapSimpleTable<IStoredPubSubSubscription>();

const { typeDefs, resolvers } = SimpleGraphqlApi();
const schema = makeExecutableSchema({ typeDefs, resolvers });
const apolloServer = new ApolloServer({
  context: WebSocketOverHttpContextFunction({
    grip: {
      url: process.env.GRIP_URL || "http://localhost:5561",
    },
    pubSubSubscriptionStorage,
    schema,
  }),
  schema,
});

const PORT = process.env.PORT || 57410;
const app = express().use(
  // This is what you need to support WebSocket-Over-Http Subscribes
  GraphqlWsOverWebSocketOverHttpExpressMiddleware({
    connectionStorage,
    pubSubSubscriptionStorage,
    schema,
  }),
);

apolloServer.applyMiddleware({ app });

const httpServer = http.createServer(app);
apolloServer.installSubscriptionHandlers(httpServer);

// ⚠️ Pay attention to the fact that we are calling `listen` on the http server variable, and not on `app`.
httpServer.listen(PORT, () => {
  console.log(
    `🚀 Server ready at http://localhost:${PORT}${apolloServer.graphqlPath}`,
  );
  console.log(
    `🚀 Subscriptions ready at ws://localhost:${PORT}${apolloServer.subscriptionsPath}`,
  );
});
