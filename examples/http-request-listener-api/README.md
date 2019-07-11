# fanout-graphql-tools-example-http-request-listener-api

Example of how to use fanout-graphql-tools with an http.RequestListener (in this case, from micro).

Some node.js web libraries help you build an http.RequestListener function that can be passed to `require('http').createServer(requestListener)` to create an http.Server.

fanout-graphql-tools exports a `GraphqlWsOverWebSocketOverHttpRequestListener` constructor that wraps another RequestListener, adding support for WebSocket-Over-HTTP in the returned, new, RequestListener.

## Testing locally

1. [Install pushpin using these instructions](https://pushpin.org/docs/install/)

2. Configure your `/etc/pushpin/routes` file to contain:
    ```
    *,debug localhost:57410,over_http
    ```
3.
    In this directory,
    ```
    npm install
    npm start
    ```

    This will run the example GraphQL Server, listening on port 57410

4. Access the example in your web browser *through pushpin* using http://localhost:7999/graphql

5.
    Using the GraphiQL Playground UI that should render here, create the following subscription:
    ```graphql
    subscription {
      postAdded {
        author,
        comment,
      }
    }
    ```

6.
    Open another tab in the GraphiQL Playground, and send the following mutation:
    
    ```graphql
    mutation {
      addPost(comment:"hi", author:"you") {
        author,
        comment,
      }
    }
    ```

7. Switch back to the GraphiQL Playground tab for the subscription, and on the right side you should see the result of your mutation.
