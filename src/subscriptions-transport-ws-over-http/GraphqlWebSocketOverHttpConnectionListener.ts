import { getMainDefinition } from "apollo-utilities";
import { OperationDefinitionNode } from "graphql";
import gql from "graphql-tag";
import * as grip from "grip";

interface IOnOpenResponse {
  /** response headers */
  headers: Record<string, string>;
}

/**
 * Given a subscription IGraphqlWsStartEventPayload, return the name of the subscription field.
 * This is useful to get an identifier for a subscription query as long as the query has no arguments.
 * It does not take query variables/arguments into account.
 */
export const getSubscriptionOperationFieldName = (
  graphqlWsEventPayload: IGraphqlWsStartEventPayload,
): string => {
  const query = gql`
    ${graphqlWsEventPayload.query}
  `;
  const mainDefinition = getMainDefinition(query);
  if (mainDefinition.kind === "FragmentDefinition") {
    throw new Error(
      `Did not expect subscription mainDefinition to be FragmentDefinition`,
    );
  }
  const selections = mainDefinition.selectionSet.selections;
  const selection = selections[0];
  if (!selection) {
    throw new Error("could not parse selection from graphqlWsEvent");
  }
  if (selection.kind !== "Field") {
    throw new Error(`could not get selection from graphqlWsEvent`);
  }
  const selectedFieldName = selection.name.value;
  const gripChannel = selectedFieldName;
  return gripChannel;
};

export interface IConnectionListener {
  /** Called when connection is closed explicitly */
  onClose?(closeCode: string): Promise<void>;
  /** Called when connection is disconnected uncleanly */
  onDisconnect?(): Promise<void>;
  /** Called with each message on the socket. Should return promise of messages to issue in response */
  onMessage(message: string): Promise<string | void>;
  /** Called when connection opens */
  onOpen?(): Promise<void | IOnOpenResponse>;
}

export interface IWebSocketOverHTTPConnectionInfo {
  /** Connection-ID from Pushpin */
  id: string;
  /** WebSocketContext for this connection. Can be used to issue grip control messages */
  webSocketContext: grip.WebSocketContext;
  /** Sec-WebSocket-Protocol */
  protocol?: string;
}

/** interface for payload that comes up in a graphql-ws start event */
export interface IGraphqlWsStartEventPayload {
  /** graphql query operationName. Could be user-provided input */
  operationName: string | null;
  /** GraphQL query */
  query: string;
  /** Variables passed to GraphQL query */
  variables: { [variable: string]: any };
}

/**
 * https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md#gql_start
 */
export interface IGraphqlWsStartMessage {
  /** Subscription Operation ID */
  id: string;
  /** Message payload including subscription query */
  payload: IGraphqlWsStartEventPayload;
  /** Message type. Indicates that this is a start message */
  type: "start";
}

/** Return whether the provided value matches IGraphqlWsStartMessage  */
export const isGraphqlWsStartMessage = (
  o: any,
): o is IGraphqlWsStartMessage => {
  return (
    typeof o === "object" &&
    typeof o.id === "string" &&
    o.type === "start" &&
    typeof o.payload === "object" &&
    typeof o.payload.query === "string"
  );
};

/** https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md#gql_stop */
export interface IGraphqlWsStopMessage {
  /** Subscription Operation ID */
  id: string;
  /** Message type. Indicates that this is a start message */
  type: "stop";
}

/** Return whether the provided value matches IGraphqlWsStopMessage  */
export const isGraphqlWsStopMessage = (o: any): o is IGraphqlWsStopMessage => {
  return typeof o === "object" && typeof o.id === "string" && o.type === "stop";
};

export interface IGetGripChannelByConnectionSelector {
  /** connection info */
  connection: {
    /** connection id */
    id: string;
  };
}

export interface IGraphqlWebSocketOverHttpConnectionListenerOptions {
  /** Info about the WebSocket-Over-HTTP Connection */
  connection: IWebSocketOverHTTPConnectionInfo;
  /** WebSocket-Over-HTTP options */
  webSocketOverHttp?: {
    /** how often to ask ws-over-http gateway to make keepalive requests */
    keepAliveIntervalSeconds?: number;
  };
  /** Handle a websocket message and optionally return a response */
  getMessageResponse(message: string): void | string | Promise<string | void>;
  /**
   * Given a subscription operation, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates
   */
  getGripChannels(
    subscriptionOperation:
      | IGraphqlWsStartMessage
      | IGraphqlWsStopMessage
      | IGetGripChannelByConnectionSelector,
  ): Promise<string[]>;
  /** Cleanup after a connection has closed/disconnected, e.g. delete all stored subscriptions created by the connection */
  cleanupConnection(
    connection: IWebSocketOverHTTPConnectionInfo,
  ): Promise<void>;
}

/**
 * GraphqlWebSocketOverHttpConnectionListener
 * WebSocket-Over-HTTP Connection Listener that tries to mock out a basic graphql-ws.
 */
export default (
  options: IGraphqlWebSocketOverHttpConnectionListenerOptions,
): IConnectionListener => {
  /**
   * Called to permanent end a connection, clean it up, and unsubscribe from all the connection's subscriptions.
   * It should be called after receiving WebSocket-Over-HTTP close and disconnect events
   */
  const endConnection = async (
    connection: IWebSocketOverHTTPConnectionInfo,
  ): Promise<void> => {
    const gripChannelsForConnection = await options.getGripChannels({
      connection: { id: options.connection.id },
    });
    for (const gripChannel of gripChannelsForConnection) {
      console.debug(
        `GraphqlWebSocketOverHttpConnectionListener unsubscribing from grip-channel ${gripChannel}`,
      );
      options.connection.webSocketContext.unsubscribe(gripChannel);
    }
    await options.cleanupConnection(options.connection);
  };
  return {
    async onClose() {
      console.debug("GraphqlWebSocketOverHttpConnectionListener onClose");
      await endConnection(options.connection);
    },
    async onDisconnect() {
      console.debug("GraphqlWebSocketOverHttpConnectionListener onDisconnect");
      await endConnection(options.connection);
    },
    async onMessage(message) {
      const graphqlWsEvent = JSON.parse(message);
      if (isGraphqlWsStartMessage(graphqlWsEvent)) {
        for (const gripChannel of await options.getGripChannels(
          graphqlWsEvent,
        )) {
          console.debug(
            `GraphqlWebSocketOverHttpConnectionListener requesting grip subscribe to channel ${gripChannel}`,
          );
          options.connection.webSocketContext.subscribe(gripChannel);
        }
      } else if (isGraphqlWsStopMessage(graphqlWsEvent)) {
        for (const gripChannel of await options.getGripChannels(
          graphqlWsEvent,
        )) {
          console.debug(
            `GraphqlWebSocketOverHttpConnectionListener unsubscribing from grip-channel ${gripChannel}`,
          );
          options.connection.webSocketContext.unsubscribe(gripChannel);
        }
      }
      return options.getMessageResponse(message);
    },
    async onOpen() {
      const webSocketOverHttpOptions = options.webSocketOverHttp;
      const keepAliveIntervalSeconds =
        webSocketOverHttpOptions &&
        webSocketOverHttpOptions.keepAliveIntervalSeconds;
      const headers: Record<string, string> = {
        ...(options.connection.protocol
          ? { "sec-websocket-protocol": options.connection.protocol }
          : {}),
        ...(keepAliveIntervalSeconds && keepAliveIntervalSeconds < Infinity
          ? { "Keep-Alive-Interval": String(keepAliveIntervalSeconds) }
          : {}),
      };
      return { headers };
    },
  };
};
