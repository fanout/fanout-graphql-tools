# Configuring GRIP Channel Naming with `getGripChannel`

Several functions in this package support a `getGripChannel` option that allows a developer to configure what [GRIP](https://pushpin.org/docs/protocols/grip/) Channel Name is used for each graphql-ws subscription.

The value of this option should be a function that matches the [`GraphqlWsGripChannelNamer` type](https://github.com/fanout/fanout-graphql-tools/blob/master/src/subscriptions-transport-ws-over-http/GraphqlWsGripChannelNamers.ts#L7). At the time of this writing, that means the `getGripChannel` function will be passed a [WebSocket-Over-HTTP](https://pushpin.org/docs/protocols/websocket-over-http/) Connection-Id string as well as the [graphql-ws start message](https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md#gql_start) that includes a GraphQL query, variables, and operation name. The `getGripChannel` function should use this information to return a single string, which will be used as the GRIP Channel name.

If a custom `GraphqlWsGripChannelNamer` is not provided as `options.getGripChannel`, most modules in this library will use [DefaultGripChannelNamer](https://github.com/fanout/fanout-graphql-tools/blob/master/src/subscriptions-transport-ws-over-http/GraphqlWsGripChannelNamers.ts#L41), which is a GraphqlWsGripChannelNamer that simply returns the [WebSocket-Over-HTTP](https://pushpin.org/docs/protocols/websocket-over-http/) Connection-Id. With this configuration, there will always be one Grip-Channel per WebSocket client.

## Why would I configure tihs?

* Add prefixes to all your Grip-Channel names when you have many separate applications behind the same GRIP Proxy and want to ensure they never accidentally use the same channel.
* For some APIs where all clients are receiving the same messages, you may be able to make a GraphqlWsGripChannelNamer such that many clients share one or a few Grip-Channels, which can lessen the load on your GRIP Proxy and sometimes speed up message publish performance (because there are less channels to publish to).
