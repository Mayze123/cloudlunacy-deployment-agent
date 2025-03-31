# CloudLunacy Agent Integration Process - Technical Reference

## Agent Integration Workflow

### Step 1: Agent Registration

**Endpoint:** `POST /api/agents/register`

**Payload:**

```json
{
  "agentId": "unique-agent-identifier",
  "agentKey": "secure-secret-key",
  "agentName": "Descriptive Agent Name",
  "targetIp": "agent.ip.address"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Agent registered successfully",
  "agentId": "unique-agent-identifier"
}
```

**Notes:**

- agentId should be unique and follow alphanumeric pattern
- agentKey must be kept secure
- targetIp should be the public IP where the agent is hosting services

### Step 2: Route Setup

#### HTTP Route Setup

**Endpoint:** `POST /api/proxy/http`

**Authentication:** Required (agentId + agentKey)

**Payload:**

```json
{
  "agentId": "unique-agent-identifier",
  "subdomain": "desired-subdomain",
  "targetUrl": "http://internal-service:port",
  "options": {
    "useTls": true,
    "check": true
  }
}
```

**Response:**

```json
{
  "success": true,
  "domain": "desired-subdomain.apps.cloudlunacy.uk",
  "targetUrl": "http://internal-service:port"
}
```

**Notes:**

- subdomain must be unique across all agents
- targetUrl is the internal service address from agent's perspective
- Multiple HTTP routes can be created for different subdomains

#### MongoDB Route Setup

**Endpoint:** `POST /api/proxy/mongodb`

**Authentication:** Required (agentId + agentKey)

**Payload:**

```json
{
  "agentId": "unique-agent-identifier",
  "targetHost": "mongodb-host",
  "targetPort": 27017,
  "options": {
    "useTls": true
  }
}
```

**Response:**

```json
{
  "success": true,
  "domain": "unique-agent-identifier.mongodb.cloudlunacy.uk",
  "useTls": true
}
```

**Notes:**

- Only one MongoDB route per agent is supported
- When useTls is true, certificates will be automatically generated

### Step 3: Certificate Management

**Endpoint:** `GET /api/config/{agentId}`

**Authentication:** Required (agentId + agentKey)

**Response:**

```json
{
  "success": true,
  "certificates": {
    "ca": "-----BEGIN CERTIFICATE-----\n...",
    "cert": "-----BEGIN CERTIFICATE-----\n...",
    "key": "-----BEGIN PRIVATE KEY-----\n..."
  }
}
```

## Implementation Notes:

1. Save certificates to agent's filesystem:

   - CA certificate: `/etc/ssl/certs/ca.crt`
   - Agent certificate: `/etc/ssl/certs/server.crt`
   - Agent private key: `/etc/ssl/private/server.key`

2. Configure MongoDB with TLS:

   ```
   net:
     tls:
       mode: requireTLS
       certificateKeyFile: /etc/ssl/private/server.key
       certificateKeyFilePassword: ""
       CAFile: /etc/ssl/certs/ca.crt
   ```

3. Configure web services to use TLS if needed

## Authentication Process

**Endpoint:** `POST /api/agents/authenticate`

**Payload:**

```json
{
  "agentId": "unique-agent-identifier",
  "agentKey": "secure-secret-key"
}
```

**Response:**

```json
{
  "success": true,
  "token": "jwt-token"
}
```

**Notes:**

- Token should be included in subsequent requests:
  Header: `"Authorization: Bearer {token}"`
- For most API calls, use agentId + agentKey directly

## Route Management

### Get Agent Routes

**Endpoint:** `GET /api/proxy/agents/{agentId}`

**Authentication:** Required

**Response:**

```json
{
  "success": true,
  "routes": [
    {
      "type": "http",
      "domain": "subdomain.apps.cloudlunacy.uk",
      "targetUrl": "http://internal-service:port"
    },
    {
      "type": "mongodb",
      "domain": "agentid.mongodb.cloudlunacy.uk",
      "targetHost": "mongodb-host",
      "targetPort": 27017
    }
  ]
}
```

### Remove Route

**Endpoint:** `DELETE /api/proxy`

**Authentication:** Required

**Payload:**

```json
{
  "agentId": "unique-agent-identifier",
  "subdomain": "subdomain-to-remove",
  "type": "http" or "mongodb"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Route removed successfully"
}
```

**Notes:**

- For type "mongodb", the subdomain field is not required

## Technical Implementation Notes

- All API endpoints follow REST conventions
- JSON is used for all request/response payloads
- Authentication is required for most endpoints
- HTTPS is used for all API communications
- The CloudLunacy Front Server handles certificate creation and renewal
- HAProxy Data Plane API manages all proxy configuration
- Keep the agent ID and key secure as they provide administrative access

## Error Handling

Example error response:

```json
{
  "success": false,
  "error": "Descriptive error message",
  "code": 400
}
```

Common errors:

- 400: Bad Request (invalid input)
- 401: Unauthorized (invalid credentials)
- 404: Not Found (resource doesn't exist)
- 409: Conflict (resource already exists)
- 500: Internal Server Error

This document outlines the integration process for CloudLunacy agents with the refactored front server using HAProxy Data Plane API.
