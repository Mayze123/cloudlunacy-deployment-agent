# CloudLunacy Architecture - Overview

This diagram illustrates the architecture of the CloudLunacy system, focusing on the interaction between agents and the front server with HAProxy Data Plane API.

```mermaid
flowchart TD
    subgraph "Client Side"
        U[User]
        W[Web Browser]
        M[MongoDB Client]
    end

    subgraph "CloudLunacy Front Server"
        LB[Load Balancer]
        FS[Front Server API]
        DP[HAProxy Data Plane API]
        CM[Certificate Manager]

        subgraph "HAProxy"
            HF[Frontend Listeners]
            HB[Backend Servers]
            HSL[Stats/Logs]
        end

        FS <--> DP
        DP <--> HF
        DP <--> HB
        DP <--> HSL
        FS <--> CM
    end

    subgraph "VPS 1 (Agent)"
        A1[CloudLunacy Agent]
        W1[Web Application]
        DB1[MongoDB]

        A1 <--> W1
        A1 <--> DB1
    end

    subgraph "VPS 2 (Agent)"
        A2[CloudLunacy Agent]
        W2[Web Application]
        DB2[MongoDB]

        A2 <--> W2
        A2 <--> DB2
    end

    U --> W
    U --> M

    W --> LB
    M --> LB

    LB --> HF
    HF --> HB

    HB --> A1
    HB --> A2

    A1 <--"API Calls"--> FS
    A2 <--"API Calls"--> FS

    CM --"Certificate Distribution"--> A1
    CM --"Certificate Distribution"--> A2

    class FS,DP,CM primary
    class A1,A2 secondary
    class HF,HB,HSL tertiary

    classDef primary fill:#f9f,stroke:#333,stroke-width:2px
    classDef secondary fill:#bbf,stroke:#333,stroke-width:2px
    classDef tertiary fill:#fbb,stroke:#333,stroke-width:1px
```

## Component Descriptions

### Front Server Components

1. **Front Server API**

   - Provides RESTful endpoints for agent registration, route setup, and management
   - Handles authentication and permission verification
   - Coordinates with Certificate Manager and HAProxy Data Plane API

2. **HAProxy Data Plane API**

   - Manages HAProxy configuration without service disruption
   - Provides transaction-based updates for atomic changes
   - Handles route creation, modification, and deletion

3. **Certificate Manager**

   - Generates and manages TLS certificates
   - Creates Certificate Authority (CA) for the CloudLunacy ecosystem
   - Distributes certificates to agents

4. **HAProxy**
   - Frontend Listeners: Handle incoming connections and route them based on domain/subdomain
   - Backend Servers: Define where traffic should be sent based on routing rules
   - Stats/Logs: Monitor system health and traffic patterns

### Agent Components

1. **CloudLunacy Agent**

   - Registers with Front Server
   - Sets up routes for applications and databases
   - Manages local certificates
   - Handles deployment and monitoring

2. **Web Application**

   - Custom applications deployed on the VPS
   - Accessed via subdomain.apps.cloudlunacy.uk

3. **MongoDB**
   - Database instances running on the VPS
   - Accessed via agentId.mongodb.cloudlunacy.uk
   - TLS secured through HAProxy SNI routing

## Data Flow

1. **Registration Flow**: Agents register with the Front Server API
2. **Route Setup Flow**: Agents request route setup, Front Server configures HAProxy
3. **Certificate Flow**: Front Server generates certificates, agents download and install them
4. **Traffic Flow**: End users connect through HAProxy to services running on agent VPSs

This architecture provides secure, scalable, and automated management of distributed web applications and databases across multiple VPS instances.
