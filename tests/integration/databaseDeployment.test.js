/**
 * Database Deployment Integration Test
 *
 * This test verifies that MongoDB deployment requests are
 * properly routed to the database controller instead of the
 * deployment controller.
 */

const MessageHandler = require("../../src/controllers/messageHandler");

// Mock dependencies
jest.mock("../../src/controllers/deployController", () => ({
  handleDeployApp: jest.fn(),
}));

jest.mock("../../src/controllers/databaseController", () => ({
  createDatabase: jest.fn(),
  handleDatabaseManagement: jest.fn(),
  handleDatabaseDeployment: jest.fn(),
}));

const deployController = require("../../src/controllers/deployController");
const databaseController = require("../../src/controllers/databaseController");

describe("Database Deployment Integration Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should route MongoDB deployment requests to the database controller", async () => {
    // Set up a mock WebSocket
    const mockWs = {
      send: jest.fn(),
      readyState: 1,
    };

    // Create a MongoDB deployment message
    const mongoDeployMessage = {
      type: "deploy_app",
      payload: {
        deploymentId: "test-deploy-123",
        appType: "mongodb",
        serviceName: "test-mongo",
        repositoryOwner: "test-owner",
        repositoryName: "test-repo",
        branch: "main",
        githubToken: "fake-token",
        environment: "dev",
        domain: "test.domain.com",
        envVarsToken: "env-token",
      },
    };

    // Process the message
    const messageHandler = new MessageHandler();
    await messageHandler.handleMessage(mongoDeployMessage, mockWs);

    // Verify correct routing
    expect(databaseController.handleDatabaseDeployment).toHaveBeenCalledWith(
      mongoDeployMessage.payload,
      mockWs,
    );
    expect(deployController.handleDeployApp).not.toHaveBeenCalled();
  });

  it("should route regular application deployments to the deployment controller", async () => {
    // Set up a mock WebSocket
    const mockWs = {
      send: jest.fn(),
      readyState: 1,
    };

    // Create a regular app deployment message
    const appDeployMessage = {
      type: "deploy_app",
      payload: {
        deploymentId: "test-deploy-456",
        appType: "nodejs",
        serviceName: "test-app",
        repositoryOwner: "test-owner",
        repositoryName: "test-repo",
        branch: "main",
        githubToken: "fake-token",
        environment: "dev",
        domain: "test.domain.com",
        envVarsToken: "env-token",
      },
    };

    // Process the message
    const messageHandler = new MessageHandler();
    await messageHandler.handleMessage(appDeployMessage, mockWs);

    // Verify correct routing
    expect(deployController.handleDeployApp).toHaveBeenCalledWith(
      appDeployMessage.payload,
      mockWs,
    );
    expect(databaseController.handleDatabaseDeployment).not.toHaveBeenCalled();
  });
});
