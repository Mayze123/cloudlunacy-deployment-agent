# CloudLunacy Deployment Agent (Refactored)

This is a refactored version of the CloudLunacy Deployment Agent, following clean code principles to improve maintainability, readability, and testability.

## Refactoring Overview

The codebase has been refactored with the following improvements:

1. **Modular Architecture**: Separated the monolithic `agent.js` into smaller, focused modules
2. **Clear Separation of Concerns**: Each component has a single responsibility
3. **Improved Error Handling**: Consistent error handling throughout the application
4. **Better Configuration Management**: Centralized configuration in one place
5. **Enhanced Code Documentation**: Clear JSDoc comments for better code understanding
6. **Standardized Response Formats**: Consistent API responses
7. **Circular Dependency Resolution**: Implemented pattern to avoid circular dependencies
8. **Improved Directory Structure**: Properly organized code with logical grouping

## Directory Structure

```
cloudlunacy-deployment-agent/
├── src/                       # Main source code directory
│   ├── config/                # Configuration files
│   │   └── index.js           # Centralized configuration
│   ├── controllers/           # Business logic controllers
│   │   ├── databaseController.js
│   │   ├── deployController.js
│   │   ├── messageHandler.js
│   │   └── repositoryController.js
│   ├── modules/               # Core functional modules
│   │   └── zeroDowntimeDeployer.js
│   ├── services/              # Service layer components
│   │   ├── authenticationService.js
│   │   ├── metricsService.js
│   │   └── websocketService.js
│   ├── utils/                 # Utility functions and helpers
│   │   ├── databaseManager.js
│   │   ├── logger.js
│   │   ├── permissionCheck.js
│   │   └── ...
│   └── index.js               # Application entry point
├── scripts/                   # Automation and management scripts
├── tests/                     # Test files
├── templates/                 # Deployment templates
└── ...
```

## Refactoring Benefits

### 1. Improved Maintainability

- Smaller files that are easier to understand and modify
- Clear separation of concerns
- Consistent code style and patterns

### 2. Better Testability

- Each component can be tested in isolation
- Dependencies are easily mockable
- Clear interfaces between components

### 3. Enhanced Readability

- Consistent code organization
- Improved documentation
- Logical grouping of related functionality

### 4. Reduced Complexity

- Single responsibility principle applied
- Simplified error handling
- Clear control flow

### 5. Circular Dependency Resolution

- Used dependency injection pattern to break circular dependencies
- Implemented dynamic imports for cyclic dependencies
- Improved module initialization flow

### 6. Consistent Import Paths

- Fixed import paths to follow the new directory structure
- Eliminated confusion between old and new module locations
- Used relative imports for better maintainability

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- Git

### Installation

1. Clone the repository:

```bash
git clone https://github.com/yourusername/cloudlunacy-deployment-agent.git
cd cloudlunacy-deployment-agent
```

2. Install dependencies:

```bash
npm install
```

3. Set up the development environment:

```bash
npm run setup
```

### Running the Agent

#### Development Mode

```bash
npm run dev
```

#### Production Mode

```bash
npm start
```

## Environment Variables

Key environment variables:

- `NODE_ENV`: Set to `development` or `production`
- `BACKEND_URL`: URL of the CloudLunacy backend service
- `FRONT_API_URL`: URL of the CloudLunacy front API
- `AGENT_API_TOKEN`: API token for agent authentication
- `SERVER_ID`: Unique identifier for this server

## Testing

```bash
npm test
```

## License

ISC
