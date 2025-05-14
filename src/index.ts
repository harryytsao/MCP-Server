import Swagger from "swagger-client";
import { z } from "zod";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import spec from "./v1.json";

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Multi-Tag Proxy",
    version: spec.info.version,
  });

  async init() {
    // build swagger-client so we can invoke by operationId
    const client = await Swagger({
      spec,
      requestInterceptor: (req: any) => {
        req.headers["X-Org-Id"] = "<any-organization-id>";
      },
    });

    // 1) loop paths & methods in your raw spec
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods!)) {
        const {
          operationId,
          tags = [],
          parameters = [],
          requestBody,
        } = op as any;
        if (!operationId) continue;

        // 2) for each tag, mount a server (or group them however you like)
        for (const tag of tags) {
          const toolName = `${tag}_${operationId}`.replace(/\s+/g, "_");

          // 3) build your input‐schema from the raw parameters
          const paramSchemas: Record<string, z.ZodTypeAny> = {};
          for (const p of parameters) {
            switch (p.schema.type) {
              case "string":
                paramSchemas[p.name] = z.string();
                break;
              case "number":
                paramSchemas[p.name] = z.number();
                break;
              case "boolean":
                paramSchemas[p.name] = z.boolean();
                break;
              default:
                paramSchemas[p.name] = z.any();
            }
          }
          if (requestBody) {
            paramSchemas["body"] = z.any();
          }

          // 4) finally register the tool
          this.server.tool(
            toolName,
            paramSchemas, // <-- mapping name→zod schema
            async (args) => {
              // invoke via swagger-client by operationId
              const res = await client.execute({
                operationId,
                parameters: args,
              });
              // normalize response
              const isJson = res.headers["content-type"]?.includes("json");
              const text = isJson ? JSON.stringify(res.body) : await res.text();
              return { content: [{ type: "text", text }] };
            }
          );
        }
      }
    }
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // @ts-ignore
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      // @ts-ignore
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
