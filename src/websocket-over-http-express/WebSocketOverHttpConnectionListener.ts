import { IncomingHttpHeaders } from "http";

export interface IConnectionListenerOnOpenResponse {
  /** response headers */
  headers: Record<string, string>;
}

export interface IConnectionListener {
  /** Called when connection is closed explicitly */
  onClose?(closeCode: string): Promise<void>;
  /** Called when connection is disconnected uncleanly */
  onDisconnect?(): Promise<void>;
  /** Called with each message on the socket. Should return promise of messages to issue in response */
  onMessage?(message: string): Promise<string | void>;
  /** Called when connection opens */
  onOpen?(): Promise<void | IConnectionListenerOnOpenResponse>;
  /** called on each WebSocket HTTP Request */
  onHttpRequest?(request: {
    /** HTTP request headers */
    headers: IncomingHttpHeaders;
  }): Promise<void | {
    /** HTTP headers to include in response */
    headers: Record<string, string>;
  }>;
}

const composeOnCloseHandlers = (
  onCloses: Array<IConnectionListener["onClose"]>,
): IConnectionListener["onClose"] => {
  return async (closeCode: string) => {
    for (const onClose of onCloses) {
      if (onClose) {
        await onClose(closeCode);
      }
    }
  };
};

/** Merge multiple HTTP header objects, but throw if this would require merging a single headerName */
const mergedHeaders = (
  headersArray: Array<Record<string, string>>,
): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const headers of headersArray) {
    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (headerName in merged) {
        throw new Error(
          `Can't merge headers. Header ${headerName} already used.`,
        );
      }
      merged[headerName] = headerValue;
    }
  }
  return merged;
};

const composeOnOpenHandlers = (
  onOpens: Array<IConnectionListener["onOpen"]>,
): IConnectionListener["onOpen"] => {
  return async () => {
    const reduceOnOpenResponse = (
      mergedOnOpenResponse: undefined | IConnectionListenerOnOpenResponse,
      onOpenResponse: IConnectionListenerOnOpenResponse | void,
    ) => {
      if (!mergedOnOpenResponse) {
        return { headers: {} };
      }
      if (!(onOpenResponse && onOpenResponse.headers)) {
        return mergedOnOpenResponse;
      }
      return {
        ...mergedOnOpenResponse,
        headers: mergedHeaders([
          mergedOnOpenResponse.headers,
          onOpenResponse.headers,
        ]),
      };
    };
    let response: IConnectionListenerOnOpenResponse = { headers: {} };
    for (const onOpen of onOpens) {
      if (onOpen) {
        response = reduceOnOpenResponse(response, await onOpen());
      }
    }
    return response;
  };
};

type AsyncArglessVoidFunction = () => Promise<void>;
const composeAsyncArglessVoidFunctionsSequentially = (
  functions: AsyncArglessVoidFunction[],
) => {
  return async () => {
    for (const f of functions) {
      await f();
    }
  };
};

const composeOnHttpRequestHandlers = (
  onHttpRequestHandlers: Array<IConnectionListener["onHttpRequest"]>,
): IConnectionListener["onHttpRequest"] => {
  return async request => {
    const reduceResponse = (
      mergedOnOpenResponse: undefined | IConnectionListenerOnOpenResponse,
      onOpenResponse: IConnectionListenerOnOpenResponse | void,
    ) => {
      if (!mergedOnOpenResponse) {
        return { headers: {} };
      }
      if (!(onOpenResponse && onOpenResponse.headers)) {
        return mergedOnOpenResponse;
      }
      return {
        ...mergedOnOpenResponse,
        headers: mergedHeaders([
          mergedOnOpenResponse.headers,
          onOpenResponse.headers,
        ]),
      };
    };
    let response = { headers: {} };
    for (const onHttpRequest of onHttpRequestHandlers) {
      if (onHttpRequest) {
        response = reduceResponse(response, await onHttpRequest(request));
      }
    }
    return response;
  };
};

type IMessageListener = IConnectionListener["onMessage"];
/**
 * Compose multiple message handlers into a single one.
 * The resulting composition will call each of the input handlers in order and merge their responses.
 */
export const composeMessageHandlers = (
  handlers: IMessageListener[],
): IMessageListener => {
  const composedMessageHandler = async (message: string) => {
    const responses = [];
    for (const handler of handlers) {
      if (handler) {
        responses.push(await handler(message));
      }
    }
    return responses.filter(Boolean).join("\n");
  };
  return composedMessageHandler;
};

/** Compose multiple ws-over-http ConnectionListeners into one */
export const ComposedConnectionListener = (
  connectionListeners: IConnectionListener[],
): IConnectionListener => {
  const onClose = composeOnCloseHandlers(
    connectionListeners.map(c => c.onClose),
  );
  const onDisconnect = composeAsyncArglessVoidFunctionsSequentially(
    connectionListeners.map(
      c =>
        c.onDisconnect ||
        (async () => {
          return;
        }),
    ),
  );
  const onMessage = composeMessageHandlers(
    connectionListeners.map(c => c.onMessage),
  );
  const onOpen = composeOnOpenHandlers(connectionListeners.map(c => c.onOpen));
  const onHttpRequest = composeOnHttpRequestHandlers(
    connectionListeners.map(c => c.onHttpRequest),
  );
  return {
    onClose,
    onDisconnect,
    onHttpRequest,
    onMessage,
    onOpen,
  };
};
