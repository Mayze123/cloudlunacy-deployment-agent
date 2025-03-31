# CloudLunacy Deployment Agent - HAProxy Data Plane API Integration

This document explains the changes made to the CloudLunacy Deployment Agent to work with the front server's HAProxy Data Plane API implementation.

## Overview

The CloudLunacy Deployment Agent has been refactored to integrate seamlessly with the CloudLunacy Front Server that uses HAProxy Data Plane API. This integration provides:

1. Improved route management with transaction-based atomic updates
2. Enhanced security with TLS certificate handling
3. Streamlined authentication flow
4. Efficient MongoDB routing through HAProxy SNI

## Key Changes

### 1. Authentication Flow

The authentication flow has been updated to use the new API endpoints:

- **Old endpoint**: `/api/agent/authenticate`
- **New endpoint**: `/api/agents/authenticate`

The payload format has also changed:

```javascript
// Old format
{
  "agentToken": "secure-token",
  "serverId": "server-id"
}

// New format
{
  "agentId": "server-id",
  "agentKey": "secure-token"
}
```

### 2. Route Management

HTTP and MongoDB routes are now managed through specific API endpoints:

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

- **Endpoint**: `/api/proxy/mongodb`
- **Payload**:
  ```javascript
  {
    "agentId": "unique-agent-identifier",
    "targetHost": "mongodb-host",
    "targetPort": 27017,
    "options": {
      "useTls": true
    }
  }
  ```

### 3. Certificate Management

Certificates are now managed through a dedicated service that fetches certificates from the front server:

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

MongoDB connections now use HAProxy's SNI-based routing mechanism:

- Connection string format: `mongodb://<username>:<password>@<agentId>.mongodb.cloudlunacy.uk:27017/<database>?tls=true`
- TLS termination is handled by HAProxy on the front server

## Architecture Changes

The agent now follows a service-oriented architecture with core services:

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

## Development and Testing

For development and testing purposes:

1. Set `NODE_ENV=development` to enable development mode
2. Use the development environment file: `.env.dev`
3. Certificates will be stored in `./dev-cloudlunacy/certs/`

## Future Work

- Implement automatic certificate renewal
- Add support for more database types
- Enhance health check reporting

## Troubleshooting

If you encounter issues with the agent integration:

1. Check that the agent has been properly registered with the front server
2. Verify that all required environment variables are set
3. Ensure certificates have been properly downloaded and installed
4. Validate MongoDB connection parameters are correct
5. Check logs for detailed error messages

---

For more information, see the [CloudLunacy Agent Integration Process](cloudlunacy-agent-integration-guide.md) documentation.
