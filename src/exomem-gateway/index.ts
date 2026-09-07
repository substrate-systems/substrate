import { createGatewayServer, drainGatewayServer } from "./server";

const port = Number(process.env.EXOMEM_GATEWAY_PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error("EXOMEM_GATEWAY_PORT is invalid");

const server = createGatewayServer();
server.listen(port, "0.0.0.0");
process.once("SIGTERM", () => void drainGatewayServer(server));
process.once("SIGINT", () => void drainGatewayServer(server));
