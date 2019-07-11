/**
 * API Demo of adding WebSocketOverHttp support patching any http.Server
 * Almost all node.js web libraries support creating one of these from the underlying Application object.
 * In this example, we use zeit/micro, but you can do something similar with koa, express, raw node http, etc.
 */

import { ApolloServer, makeExecutableSchema } from "apollo-server-micro";
import {
  GraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstaller,
  IStoredConnection,
  IStoredPubSubSubscription,
  WebSocketOverHttpContextFunction,
} from "fanout-graphql-tools";
import { MapSimpleTable } from "fanout-graphql-tools";
import * as http from "http";
import micro from "micro";
import { SimpleGraphqlApi } from "../../../src/simple-graphql-api/SimpleGraphqlApi";

/**
 * WebSocket-Over-HTTP Support requires storage to keep track of ws-over-http connections and subscriptions.
 * The Storage objects match an ISimpleTable interface that is a subset of the @pulumi/cloud Table interface. MapSimpleTable is an in-memory implementation, but you can use @pulumi/cloud implementations in production, e.g. to use DyanmoDB.
 */
const connectionStorage = MapSimpleTable<IStoredConnection>();
const pubSubSubscriptionStorage = MapSimpleTable<IStoredPubSubSubscription>();

const schema = makeExecutableSchema(SimpleGraphqlApi());

const apolloServer = new ApolloServer({
  context: WebSocketOverHttpContextFunction({
    grip: {
      // Get this from your Fanout Cloud console, which looks like https://api.fanout.io/realm/{realm-id}?iss={realm-id}&key=base64:{realm-key}
      // or use this localhost for your own pushpin.org default installation
      url: process.env.GRIP_URL || "http://localhost:5561",
    },
    pubSubSubscriptionStorage,
    schema,
  }),
  schema,
});

// Note: In micro 9.3.5 this will return an http.RequestListener instead (after https://github.com/zeit/micro/pull/399)
// Provide it to http.createServer to create an http.Server
const httpServer: http.Server = micro(apolloServer.createHandler());

// Patch the http.Server to handle WebSocket-Over-Http requests that come from Fanout Cloud
GraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstaller({
  connectionStorage,
  pubSubSubscriptionStorage,
  schema,
})(httpServer);

const port = process.env.PORT || 57410;
httpServer.listen(port, () => {
  console.log(`Server is now running on http://localhost:${port}`);
});
