import * as http from "http";
import * as killable from "killable";
import { AddressInfo } from "net";
import * as url from "url";

interface IListeningServerInfo {
  /** url at which the server can be reached */
  url: string;
  /** host of server */
  hostname: string;
  /** port of server */
  port: number;
}

const hostOfAddressInfo = (address: AddressInfo): string => {
  const host =
    address.address === "" || address.address === "::"
      ? "localhost"
      : address.address;
  return host;
};

const urlOfServerAddress = (address: AddressInfo): string => {
  return url.format({
    hostname: hostOfAddressInfo(address),
    port: address.port,
    protocol: "http",
  });
};

/**
 * Given an httpServer and port, have the server listen on the port
 * then call the provided doWorkWithServer function with info about the running server.
 * After work is done, kill the running server to clean up.
 */
export const withListeningServer = (
  httpServer: http.Server,
  port: string | number = 0,
) => async (
  doWorkWithServer: (serverInfo: IListeningServerInfo) => Promise<void>,
) => {
  const { kill } = killable(httpServer);
  // listen
  await new Promise((resolve, reject) => {
    httpServer.on("listening", resolve);
    httpServer.on("error", error => {
      reject(error);
    });
    try {
      httpServer.listen(port);
    } catch (error) {
      reject(error);
    }
  });
  const address = httpServer.address();
  if (typeof address === "string" || !address) {
    throw new Error(`Can't determine URL from address ${address}`);
  }
  await doWorkWithServer({
    hostname: hostOfAddressInfo(address),
    port: address.port,
    url: urlOfServerAddress(address),
  });
  await new Promise((resolve, reject) => {
    try {
      kill((error: Error | undefined) => {
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
  return;
};
