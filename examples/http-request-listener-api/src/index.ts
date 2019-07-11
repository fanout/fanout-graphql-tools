/**
 * API Demo of adding WebSocketOverHttp support patching any http.Server
 * Almost all node.js web libraries support creating one of these from the underlying Application object.
 * In this example, we use zeit/micro, but you can do something similar with koa, express, raw node http, etc.
 */

import { ApolloServer, makeExecutableSchema } from "apollo-server-micro";
import {
  GraphqlWsOverWebSocketOverHttpRequestListener,
  IStoredConnection,
  IStoredPubSubSubscription,
  WebSocketOverHttpContextFunction,
} from "fanout-graphql-tools";
import { MapSimpleTable } from "fanout-graphql-tools";
import * as http from "http";
import { run as microRun } from "micro";
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

// In micro 9.3.5, the default export of micro(handler) will return an http.RequestListener (after https://github.com/zeit/micro/pull/399).
// As of this authoring, only 9.3.4 is out, which returns an http.Server. So we manually build the RequestListner here.
// After 9.3.5, the following will work:
// import micro from "micro"
// const microRequestListener = micro(apolloServer.createHandler())
const microRequestListener: http.RequestListener = (req, res) =>
  microRun(req, res, apolloServer.createHandler());

const httpServer = http.createServer(
  GraphqlWsOverWebSocketOverHttpRequestListener(microRequestListener, {
    connectionStorage,
    pubSubSubscriptionStorage,
    schema,
  }),
);

const port = process.env.PORT || 57410;
httpServer.listen(port, () => {
  console.log(`Server is now running on http://localhost:${port}${apolloServer.graphqlPath}`);
});
