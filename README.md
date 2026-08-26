# SAP Business One Order-to-Cash MCP Server

This project exposes SAP Business One Service Layer operations as Model Context Protocol (MCP) tools, so an agent such as Claude can execute the full Order-to-Cash flow over stdio.

## What is included

- Node.js + TypeScript MCP server
- SAP Business One session-cookie authentication with automatic re-login on expiry
- 9 O2C tools covering quotation through collections
- `.env`-driven configuration

## Project structure

```text
sap-b1-mcp-server/
|- src/
|  \- server.ts
|- dist/
|- .env
|- .env.example
|- package.json
|- tsconfig.json
\- README.md
```

## Tools

1. `create_sales_quotation`
2. `create_sales_order`
3. `check_atp`
4. `create_delivery`
5. `get_pick_list`
6. `confirm_delivery_pod`
7. `create_ar_invoice`
8. `apply_incoming_payment`
9. `get_collections_worklist`

## Environment

```env
SAP_B1_BASE_URL=https://your-sap-server:50000/b1s/v1
SAP_B1_COMPANY=SBODemoUS
SAP_B1_USER=manager
SAP_B1_PASSWORD=yourpassword
NODE_TLS_REJECT_UNAUTHORIZED=0
```

Set `NODE_TLS_REJECT_UNAUTHORIZED=0` only when your SAP Business One Service Layer is using a self-signed certificate.

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Run

```bash
node dist/server.js
```

Expected startup log:

```text
SAP B1 MCP server running (stdio)
```

## Claude Desktop MCP config

```json
{
  "mcpServers": {
    "sap-b1-o2c": {
      "command": "node",
      "args": ["/absolute/path/to/dist/server.js"],
      "env": {
        "SAP_B1_BASE_URL": "https://your-server:50000/b1s/v1",
        "SAP_B1_COMPANY": "SBODemoUS",
        "SAP_B1_USER": "manager",
        "SAP_B1_PASSWORD": "yourpassword"
      }
    }
  }
}
```

## Notes

- The server connects to SAP Business One over the Service Layer REST API.
- Session cookies are renewed automatically when login expires.
- The invoice and payment tools are implemented as live posting operations, so it is a good idea to keep a human approval step in your agent workflow.
- Some organizations store carrier, POD, and approval metadata in user-defined fields. This scaffold stores those references in document comments by default to stay portable across SAP B1 tenants.

## Common issues

- `UNABLE_TO_VERIFY_LEAF_SIGNATURE`: set `NODE_TLS_REJECT_UNAUTHORIZED=0` for self-signed SAP certificates
- `SAP B1 login failed`: verify base URL, company DB, user, and password
- `ECONNREFUSED`: confirm the Service Layer is running and reachable
- `Cannot find module`: run `npm install` and `npm run build`
- MCP tools not showing up: verify the absolute path in your Claude MCP config