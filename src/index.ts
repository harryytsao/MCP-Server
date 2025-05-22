import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import openApiSchema from "./v3.json";

// Helper type for OpenAPI path parameters
type PathParameter = {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: {
    type: string;
    format?: string;
  };
};

// Helper type for OpenAPI property schema
type OpenAPIPropertySchema = {
  type?: string;
  format?: string;
  $ref?: string;
  default?: any;
  nullable?: boolean;
  enum?: string[];
};

// Helper type for OpenAPI schema objects
type OpenAPISchemaObject = {
  type?: string;
  required?: string[];
  properties?: {
    [key: string]: OpenAPIPropertySchema;
  };
  enum?: string[];
};

// Helper type for OpenAPI components
type OpenAPIComponents = {
  schemas: {
    [key: string]: OpenAPISchemaObject;
  };
};

// Helper to convert OpenAPI types to Zod schemas
function getZodSchemaForParameter(param: PathParameter): z.ZodTypeAny {
  let schema: z.ZodTypeAny = z.string();
  if (param.schema.type === "integer") {
    schema = z.number().int();
  } else if (param.schema.type === "number") {
    schema = z.number();
  }
  return param.required ? schema : schema.optional();
}

// Helper to resolve schema references and create Zod schemas
function resolveSchemaRef(
  ref: string | undefined,
  prop: OpenAPIPropertySchema,
  schemas: OpenAPIComponents["schemas"]
): z.ZodTypeAny {
  if (ref) {
    const refPath = ref.split("/").slice(1);
    const schemaName = refPath[refPath.length - 1];
    const referencedSchema = schemas[schemaName];

    if (referencedSchema.enum) {
      return z.enum(referencedSchema.enum as [string, ...string[]]);
    }
  }

  if (prop.enum) {
    return z.enum(prop.enum as [string, ...string[]]);
  }

  if (prop.type === "integer") {
    return z.number().int();
  } else if (prop.type === "string") {
    if (prop.format === "uuid") {
      // accept either a real UUID *or* the placeholder string
      return z.union([z.string().uuid(), z.literal("{{$guid}}")]);
    } else if (prop.format === "date-time" || prop.format === "datetime") {
      // accept either a real ISO-8601 datetime *or* the placeholder
      return z.union([
        z.string().datetime({ offset: true }),
        z.literal("{{$datetime iso8601}}"),
      ]);
    } else if (prop.format === "date") {
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    } else if (prop.format === "time") {
      return z.string().regex(/^\d{2}:\d{2}:\d{2}$/);
    }
    return z.string();
  } else if (prop.type === "number") {
    return z.number();
  } else if (prop.type === "boolean") {
    return z.boolean();
  }

  return z.string();
}

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Integrations",
    version: "1.0.0",
  });

  private createToolFromEndpoint(
    path: string,
    method: string,
    operation: any,
    baseUrl: string,
    organizationId: string
  ) {
    const toolName =
      operation.operationId || `${method}${path.replace(/[/{}/]/g, "_")}`;
    const parameters = operation.parameters || [];

    // Build Zod schema for parameters
    const paramSchema: Record<string, any> = {};

    // Handle path parameters
    parameters.forEach((param: PathParameter) => {
      if (param.in === "path") {
        paramSchema[param.name] = getZodSchemaForParameter(param);
      }
    });

    // Handle request body if it exists
    if (operation.requestBody?.content?.["application/json"]?.schema?.$ref) {
      const refPath = operation.requestBody.content[
        "application/json"
      ].schema.$ref
        .split("/")
        .slice(1);

      // Start with components.schemas
      const schemas = (openApiSchema.components as OpenAPIComponents).schemas;
      // Get the referenced schema
      const schemaName = refPath[refPath.length - 1];
      const referencedSchema = schemas[schemaName];

      // Add all fields from the schema, marking required ones as required
      if (referencedSchema.properties) {
        Object.entries(referencedSchema.properties).forEach(([field, prop]) => {
          if (prop) {
            const zodSchema = resolveSchemaRef(prop.$ref, prop, schemas);
            paramSchema[field] = referencedSchema.required?.includes(field)
              ? zodSchema
              : zodSchema.optional();
          }
        });
      }
    }

    // Create the tool
    this.server.tool(toolName, paramSchema, async (params) => {
      try {
        // Pre-process special placeholders in params before validation
        const processedParams = { ...params };
        Object.entries(processedParams).forEach(([key, value]) => {
          if (typeof value === "string") {
            if (value === "{{$guid}}") {
              processedParams[key] = crypto.randomUUID();
            } else if (value === "{{$datetime iso8601}}") {
              processedParams[key] = new Date().toISOString();
            }
          }
        });

        // Validate processed params against schema
        const validatedParams = z.object(paramSchema).parse(processedParams);

        // For Hawksoft endpoints, ensure we use the full integration path
        let finalPath = path;
        if (
          !finalPath.startsWith("/integrations") &&
          finalPath.includes("/hawksoft/")
        ) {
          finalPath = `/integrations${finalPath}`;
        }

        // Replace path parameters
        Object.entries(validatedParams).forEach(([key, value]) => {
          if (path.includes(`{${key}}`)) {
            finalPath = finalPath.replace(
              `{${key}}`,
              encodeURIComponent(String(value))
            );
          }
        });

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: operation.responses["200"].content?.["application/json"]
            ? "application/json"
            : "text/plain",
        };

        // Add required headers from parameters
        parameters.forEach((param: PathParameter) => {
          if (param.in === "header" && param.required) {
            if (param.name === "X-Org-Id") {
              headers[param.name] = organizationId;
            }
          }
        });

        // Ensure X-Org-Id is set for Hawksoft endpoints
        if (finalPath.includes("/hawksoft/")) {
          headers["X-Org-Id"] = organizationId;
        }

        const requestInit: RequestInit = {
          method: method.toUpperCase(),
          headers,
        };

        // Add request body if needed
        if (operation.requestBody) {
          const bodyParams = { ...validatedParams };
          // Transform ClientNumber to clientNumber for Hawksoft endpoints
          if (bodyParams.ClientNumber !== undefined) {
            bodyParams.clientNumber = bodyParams.ClientNumber;
            delete bodyParams.ClientNumber;
          }
          requestInit.body = JSON.stringify(bodyParams);
        }

        console.log(`Making request to: ${baseUrl}${finalPath}`, {
          method: requestInit.method,
          headers: { ...headers },
          body: requestInit.body
            ? JSON.parse(requestInit.body as string)
            : undefined,
        });

        const res = await fetch(`${baseUrl}${finalPath}`, requestInit);

        const body = await res.text();
        console.log(
          `${toolName} response:`,
          res.status,
          res.statusText,
          "|",
          body
        );

        if (!res.ok) {
          throw new Error(body || `HTTP error ${res.status}`);
        }

        let responseContent;
        try {
          // Try to parse as JSON if the response is JSON
          responseContent = JSON.parse(body);

          // Format objects for better readability
          if (typeof responseContent === "object") {
            if (Array.isArray(responseContent)) {
              // If it's an array, format each item
              responseContent = responseContent
                .map((item) =>
                  typeof item === "object"
                    ? JSON.stringify(item, null, 2)
                    : item
                )
                .join("\n\n");
            } else {
              // If it's a single object, format it
              responseContent = JSON.stringify(responseContent, null, 2);
            }
          }
        } catch {
          // If not JSON, use as plain text
          responseContent = body;
        }

        return {
          content: [{ type: "text", text: String(responseContent) }],
        };
      } catch (error: any) {
        console.error(`Error in ${toolName}:`, error);
        return {
          content: [
            {
              type: "text",
              text: `Error in ${toolName}: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  async init() {
    const baseUrl = "http://localhost:9999";
    const organizationId = "8232f2d1-91f2-4d17-9a7e-756dd5dc7544";

    // Create tools from OpenAPI schema
    Object.entries(openApiSchema.paths).forEach(
      ([path, pathItem]: [string, any]) => {
        Object.entries(pathItem).forEach(
          ([method, operation]: [string, any]) => {
            // Skip if operation is not a HTTP method
            if (!["get", "post", "put", "delete", "patch"].includes(method)) {
              return;
            }
            this.createToolFromEndpoint(
              path,
              method,
              operation,
              baseUrl,
              organizationId
            );
          }
        );
      }
    );

    // Calculator tool with multiple operations
    this.server.tool(
      "calculate",
      {
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        a: z.number(),
        b: z.number(),
      },
      async ({ operation, a, b }) => {
        let result: number;
        switch (operation) {
          case "add":
            result = a + b;
            break;
          case "subtract":
            result = a - b;
            break;
          case "multiply":
            result = a * b;
            break;
          case "divide":
            if (b === 0)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: Cannot divide by zero",
                  },
                ],
              };
            result = a / b;
            break;
        }
        return { content: [{ type: "text", text: String(result) }] };
      }
    );
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
