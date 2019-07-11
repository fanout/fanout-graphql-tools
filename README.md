# fanout-graphql-tools

Modules that help make GraphQL servers that work with [Fanout Cloud](https://fanout.io/cloud/).

See [fanout/apollo-demo](https://github.com/fanout/apollo-demo) for an example project that uses this to power a GraphQL API server with GraphQL Subscriptions on AWS Lambda.

Fanout Cloud can act as a reverse proxy between your users' web browsers and your GraphQL API, holding open long-running WebSocket connections so your server (or function-as-a-service) doesn't have to. Instead, Fanout Cloud makes simple regular HTTP Requests to your application using the [WebSocket-Over-HTTP Protocol](https://pushpin.org/docs/protocols/websocket-over-http/). The tools in this library allow your GraphQL API server to serve the GraphQL Subscriptions protocol ([`graphql-ws`](https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md)) over WebSocket-Over-HTTP.

## Usage

### With apollo-server

Let's say you already have a project that uses apollo-server to make a GraphQL API with subscriptions. Follow these steps to make it work with Fanout.

0. Make some decisions about your data stores. These tools require a persistent place to store data of two types: GraphQL PubSub Subscriptions as well as WebSocket-Over-HTTP Connections. You must provide storage objects that implement the [ISimpleTable](./src/simple-table/SimpleTable.ts) interface.
    * You can make your own and store data wherever you want.
    * This interface is a subset of the [`@pulumi/cloud.Table`](https://www.pulumi.com/docs/reference/pkg/nodejs/pulumi/cloud/#Table) interface, so you can use those too. Pulumi has implementations for [AWS DyanmoDB](https://github.com/pulumi/pulumi-cloud/blob/master/aws/table.ts) as well as [Azure Table Storage](https://github.com/pulumi/pulumi-cloud/blob/master/azure/table.ts).
    * If you want to use another data store not listed here and need help, file an issue to let us know.
    * When developing, you can use `MapSimpleTable`, which stores data in-memory in a `Map` object. But the data won't be very persistent.

        Here's an example of creating these storage objects using `MapSimpleTable`.
        ```typescript
        import { MapSimpleTable, IStoredPubSubSubscription, IStoredConnection } from "fanout-graphql-tools"

        const connectionStorage = MapSimpleTable<IStoredConnection>()
        const pubSubSubscriptionStorage = MapSimpleTable<IStoredPubSubSubscription>()
        ```

1. Use `WebSocketOverHttpContextFunction` when constructing `ApolloServer`. This adds some properties to your GraphQL Context that can later be used in your GraphQL Resolvers.

    ```typescript
    import { WebSocketOverHttpContextFunction } from "fanout-graphql-tools"
    // you may get ApolloServer from elsewhere, e.g. apollo-server-express
    import { ApolloServer } from "apollo-server"
    import { makeExecutableSchema } from "graphql-tools";
    import MyGraphqlApi from "./my-graphql-api"

    // these depend on your specific API, e.g. https://github.com/apollographql/apollo-server#installation-standalone
    const { typeDefs, resolvers } = MyGraphqlApi()
    const schema = makeExecutableSchema({ typeDefs, resolvers })

    const apolloServer = ApolloServer({
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
    })
    ```

    You can see a full example of this [here](./src/examples/apollo-server-express-api.ts)

2.
    In your GraphQL Resolvers, wrap all usages of `pubsub` with `WebSocketOverHttpPubsubMixin(context)(pubsub)`.
    
    Every `ApolloServer` has to be created with some [GraphQL Resolvers](https://www.apollographql.com/docs/graphql-tools/resolvers/). To power GraphQL Subscriptions, these resolvers make use of a [`PubSubEngine`](https://www.apollographql.com/docs/apollo-server/features/subscriptions/#subscriptions-example). In mutation resolvers, you call `pubsub.publish(triggerName, payload)`. In your subscription resolvers, you call `pubsub.asyncIterator(triggerName)`.

    Here's a before/after example

    * Before (example from the [official Apollo docs on subscriptions](https://www.apollographql.com/docs/apollo-server/features/subscriptions/#subscriptions-example).)
      ```typescript
      const resolvers = {
        Subscription: {
          postAdded: {
            // Additional event labels can be passed to asyncIterator creation
            subscribe: () => pubsub.asyncIterator([POST_ADDED]),
          },
        },
        Mutation: {
          addPost(root: any, args: any, context: any) {
            pubsub.publish(POST_ADDED, { postAdded: args });
            return postController.addPost(args);
          },
        },
      };
      ```
    * After wrapping pubsubs with `WebSocketOverHttpPubsubMixin(context)(pubsub)`
      ```typescript
      import { WebSocketOverHttpPubsubMixin } from "fanout-graphql-tools"
      const resolvers = {
        Subscription: {
          postAdded: {
            // Additional event labels can be passed to asyncIterator creation
            subscribe: (source, args, context) => WebSocketOverHttpPubsubMixin(context)(pubsub).asyncIterator([POST_ADDED]),
          },
        },
        Mutation: {
          addPost(root: any, args: any, context: any) {
            WebSocketOverHttpPubsubMixin(context)(pubsub).publish(POST_ADDED, { postAdded: args });
            return postController.addPost(args);
          },
        },
      };
      ```

      You can see a full example of this in [SimpleGraphqlApi](./src/simple-graphql-api/SimpleGraphqlApi.ts)

3. Add WebSocket-Over-HTTP handling to the http server that serves your GraphQL App. The way to do this depends on how you make an HTTP Server.
    * apollo-server-express

      Many projects use `ApolloServer` along with the [Express](https://expressjs.com/) web framework. There is an official apollo-server integration called [apollo-server-express](https://github.com/apollographql/apollo-server/tree/master/packages/apollo-server-express). You can add WebSocket-Over-HTTP handling to your epxress app with `GraphqlWsOverWebSocketOverHttpExpressMiddleware`.

      ```typescript
      import * as express from "express"
      import { GraphqlWsOverWebSocketOverHttpExpressMiddleware } from "fanout-graphql-tools"
      import { makeExecutableSchema } from "graphql-tools";
      import MyGraphqlApi from "./my-graphql-api"

      // these depend on your specific API, e.g. https://github.com/apollographql/apollo-server#installation-standalone
      const { typeDefs, resolvers } = MyGraphqlApi()
      const schema = makeExecutableSchema({ typeDefs, resolvers })
      const app = express()
        .use(GraphqlWsOverWebSocketOverHttpExpressMiddleware({
          // we created these earlier, remember?
          connectionStorage,
          pubSubSubscriptionStorage,
          schema,
        }))
      
      // later, do `ApolloServer(/*...*/).applyMiddleware({ app })
      ```

      You can see a full example of this [here](./src/examples/apollo-server-express-api.ts)

    * Other web frameworks

      Not everyone uses express. That's fine. We still want to work with your project. Many node.js web frameworks ultimately end up using the `http` module from the standard library behind the scenes. If your web framework gives you a reference to an underlying `http.Server` instance, you can use `GraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstaller` to install WebSocket-Over-HTTP handling to it.

      ```typescript
      import * as http from "http"
      import { GraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstaller } from "fanout-graphql-tools"
      import { makeExecutableSchema } from "graphql-tools";
      import MyGraphqlApi from "./my-graphql-api"

      // these depend on your specific API, e.g. https://github.com/apollographql/apollo-server#installation-standalone
      const { typeDefs, resolvers } = MyGraphqlApi()
      const schema = makeExecutableSchema({ typeDefs, resolvers })
      
      // However you get here, e.g. with https://github.com/zeit/micro
      const httpServer: http.Server = http.createServer(requestListener)

      GraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstaller({
        connectionStorage,
        pubSubSubscriptionStorage,
        schema,
      })(httpServer);

      ```
    * Have a question about this part? File an issue and we can help out and add to the docs.

Those are the steps for using fanout-graphql-tools. See [apollo-demo](https://github.com/fanout/apollo-demo) for a fully functional app, running in AWS Lambda and storing data in DynamoDB.

## Development

### Releasing New Versions

Release a new version of this package by pushing a git tag with a name that is a semver version like "v0.0.2".
Make sure you also update the `package.json` to have the same version.

The best way to do this is using [`npm version <newversion>`](https://docs.npmjs.com/cli/version), which will update `package.json`, then create a git commit, then create a git tag pointing to that git commit. You should run this in the master branch.

After that you can push the commit and new tags using `git push --follow-tags`.

```
npm version minor
git push --follow-tags
```

[Travis](https://travis-ci.org/fanout/fanout-graphql-tools) is configured to test and publish all git tags to [npm](https://www.npmjs.com/package/fanout-graphql-tools). You don't need to run `npm publish` locally.
