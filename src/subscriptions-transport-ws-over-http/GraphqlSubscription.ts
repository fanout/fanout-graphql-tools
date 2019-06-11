/** interface of stored record of a GraphqlSubscription */
export interface IGraphqlSubscription {
  /** unique identifier for the client connection that issued this subscription. A connection can create many subscriptions */
  connectionId: string;
  /** date the subscription was stored. As [ISO_8601](http://en.wikipedia.org/wiki/ISO_8601) UTC string */
  createdAt: string;
  /** unique identifier for the subscription */
  id: string;
  /** Provided by the subscribing client in graphql-ws 'GQL_START' message. Must be sent in each published 'GQL_DATA' message */
  operationId: string;
  /**
   * The GQL_START message that started the subscription. It includes the query and stuff.
   * https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md#gql_start
   */
  startMessage: string;
  /** The name of the field in the GraphQL Schema being subscribed to. i.e. what you probably think of as the subscription name */
  subscriptionFieldName: string;
}
