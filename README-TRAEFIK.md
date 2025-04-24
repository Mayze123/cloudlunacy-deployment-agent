# CloudLunacy Deployment Agent - Traefik Integration

This document explains the CloudLunacy Deployment Agent's integration with the front server's Traefik implementation.

## Overview

The CloudLunacy Deployment Agent integrates seamlessly with the CloudLunacy Front Server that uses Traefik for routing. This integration provides:

1. Efficient route management through Traefik's dynamic configuration
2. Enhanced security with TLS certificate handling
3. Streamlined authentication flow
4. Efficient MongoDB routing through Traefik's hostname-based routing

## Key Changes

### 1. Authentication Flow

The authentication flow uses the API endpoints:

- **Endpoint**: `/api/agents/authenticate`

The payload format:

```javascript
{
  "agentId": "server-id",
  "agentKey": "secure-token"
}
```

### 2. Route Management

HTTP and MongoDB routes are managed through specific API endpoints:

#### HTTP Routes

- **Endpoint**: `/api/proxy/http`
- **Payload**:
  ```javascript
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

#### MongoDB Routes

- **Endpoint**: `/api/mongodb/register`
- **Payload**:
  ```javascript
  {
    "agentId": "unique-agent-identifier",
    "targetIp": "mongodb-host-ip",
    "targetPort": 27017,
    "useTls": true
  }
  ```

### 3. Certificate Management

Certificates are managed through a dedicated service that fetches certificates from the front server:

- **Endpoint**: `/api/config/{agentId}`
- **Response**:
  ```javascript
  {
    "success": true,
    "certificates": {
      "ca": "-----BEGIN CERTIFICATE-----\n...",
      "cert": "-----BEGIN CERTIFICATE-----\n...",
      "key": "-----BEGIN PRIVATE KEY-----\n..."
    }
  }
  ```

### 4. MongoDB Connection

MongoDB connections use Traefik's hostname-based routing mechanism:

- Connection string format: `mongodb://<username>:<password>@<agentId>.mongodb.cloudlunacy.uk:27017/<database>?tls=true`
- TLS termination is handled by Traefik on the front server

## Architecture

The agent follows a service-oriented architecture with core services:

1. **Config Service**: Manages agent configuration and environment variables
2. **Authentication Service**: Handles agent authentication with the front server
3. **Certificate Service**: Manages certificate retrieval and storage
4. **Deployment Service**: Handles application deployment
5. **WebSocket Service**: Manages WebSocket communication
6. **Metrics Service**: Collects and reports agent metrics

## Integration Process

The agent follows a 3-step process to integrate with the front server:

1. **Registration**: Register with the front server to establish identity
2. **Route Setup**: Configure HTTP and/or MongoDB routes
3. **Certificate Management**: Retrieve and install certificates

## Technical Implementation Notes

- TLS is always enabled for MongoDB connections
- The agent uses the subdomain format `{agentId}.mongodb.cloudlunacy.uk` for MongoDB connections
- All API communications use HTTPS
- JWT tokens are used for authentication

## Local Connectivity Workaround

For cases where the Traefik routing is not properly configured or is temporarily unavailable, the agent includes a fallback mechanism to connect directly to the local MongoDB instance. This ensures that operations can continue even if there are issues with the front server routing.

## Development and Testing

For development and testing purposes:

1. Set `NODE_ENV=development` to enable development mode
2. Use the development environment file: `.env.dev`
3. Certificates will be stored in `./dev-cloudlunacy/certs/`

## Troubleshooting

If you encounter issues with the agent integration:

1. Check that the agent has been properly registered with the front server
2. Verify that all required environment variables are set
3. Ensure certificates have been properly downloaded and installed
4. Validate MongoDB connection parameters are correct
5. Check logs for detailed error messages

Network diagnostics are automatically run when attempting a connection, which can help identify connectivity issues with the front server.

---

For more information, see the [CloudLunacy Agent Integration Process](cloudlunacy-agent-integration-guide.md) documentation.
