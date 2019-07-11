import * as querystring from "querystring";
import {
  getSubscriptionOperationFieldName,
  IGraphqlWsStartMessage,
} from "./GraphqlWebSocketOverHttpConnectionListener";

/**
 * A function that will return the Grip-Channel to use for the provided IGraphqlWsStartMessage.
 * This will only work for GraphQL APIs with subscriptions that dont have arguments.
 * The Grip-Channel will be based on the subscription field name + the graphqlWsStartMessage operation id
 */
export const gripChannelForSubscriptionWithoutArguments = (
  graphqlWsStartMessage: IGraphqlWsStartMessage,
): string => {
  const subscriptionFieldName = getSubscriptionOperationFieldName(
    graphqlWsStartMessage.payload,
  );
  const gripChannel = `${subscriptionFieldName}?${querystring.stringify(
    sorted({
      "subscription.operation.id": graphqlWsStartMessage.id,
    }),
  )}`;
  return gripChannel;
};

/** Create the default getGripChannel that should be used by other fanout-graphql-tools */
export const DefaultGripChannelNamer = () =>
  gripChannelForSubscriptionWithoutArguments;

/**
 * given an object, return the same, ensuring that the object keys were inserted in alphabetical order
 * https://github.com/nodejs/node/issues/6594#issuecomment-217120402
 */
function sorted(o: any) {
  const p = Object.create(null);
  for (const k of Object.keys(o).sort()) {
    p[k] = o[k];
  }
  return p;
}
