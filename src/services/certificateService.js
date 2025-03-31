/**
 * Certificate Service
 *
 * Handles the retrieval, storage, and management of TLS certificates
 * from the CloudLunacy Front Server.
 */

const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const logger = require("../../utils/logger");
const config = require("../config");

class CertificateService {
  constructor() {
    this.certsDir = process.env.CERTS_DIR || "/opt/cloudlunacy/certs";
    this.caPath = path.join(this.certsDir, "ca.crt");
    this.certPath = path.join(this.certsDir, "server.crt");
    this.keyPath = path.join(this.certsDir, "server.key");
    this.pemPath = path.join(this.certsDir, "server.pem");
  }

  /**
   * Initialize the certificate service by ensuring required directories exist
   */
  async initialize() {
    try {
      // Ensure certificates directory exists
      await fs.mkdir(this.certsDir, { recursive: true });

      // Set appropriate permissions in production mode
      if (!config.isDevelopment) {
        try {
          execSync(`chmod 700 ${this.certsDir}`);
        } catch (err) {
          logger.warn(
            `Could not set permissions on certificate directory: ${err.message}`,
          );
        }
      }

      logger.info("Certificate service initialized successfully");
      return true;
    } catch (error) {
      logger.error(
        `Failed to initialize certificate service: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Fetch certificates from the front server
   * @returns {Promise<boolean>} Success status
   */
  async fetchCertificates() {
    try {
      if (config.isDevelopment) {
        logger.info("Development mode: Using mock certificates");
        return await this.createDevelopmentCertificates();
      }

      logger.info("Fetching certificates from front server...");

      // Ensure we have the token required for authentication
      if (!config.api.jwt) {
        throw new Error("JWT token not available - cannot fetch certificates");
      }

      // Use the new API endpoint for certificate management
      const response = await axios.get(
        `${config.api.frontApiUrl}/api/config/${config.serverId}`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.api.jwt}`,
          },
        },
      );

      if (!response.data || !response.data.success) {
        throw new Error("Invalid response from certificate endpoint");
      }

      const { certificates } = response.data;

      if (
        !certificates ||
        !certificates.ca ||
        !certificates.cert ||
        !certificates.key
      ) {
        throw new Error("Missing certificate data in response");
      }

      // Save certificates to filesystem
      await fs.writeFile(this.caPath, certificates.ca);
      await fs.writeFile(this.certPath, certificates.cert);
      await fs.writeFile(this.keyPath, certificates.key);

      // Create combined PEM file for services that need it
      await fs.writeFile(this.pemPath, certificates.key + certificates.cert);

      // Set appropriate permissions
      if (!config.isDevelopment) {
        try {
          execSync(`chmod 600 ${this.keyPath}`);
          execSync(`chmod 600 ${this.pemPath}`);
          execSync(`chmod 644 ${this.certPath}`);
          execSync(`chmod 644 ${this.caPath}`);
        } catch (err) {
          logger.warn(
            `Could not set permissions on certificates: ${err.message}`,
          );
        }
      }

      logger.info("Certificates fetched and saved successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to fetch certificates: ${error.message}`);
      if (error.response) {
        logger.error(
          `Server responded with: ${JSON.stringify(error.response.data)}`,
        );
      }
      return false;
    }
  }

  /**
   * Create development certificates for testing purposes
   * @returns {Promise<boolean>} Success status
   */
  async createDevelopmentCertificates() {
    // Only for development mode - creates mock certificates
    if (!config.isDevelopment) {
      logger.warn("Cannot create development certificates in production mode");
      return false;
    }

    try {
      // Create mock CA certificate
      const mockCa =
        "-----BEGIN CERTIFICATE-----\nMOCK CA CERTIFICATE FOR DEVELOPMENT\n-----END CERTIFICATE-----";
      await fs.writeFile(this.caPath, mockCa);

      // Create mock server certificate
      const mockCert =
        "-----BEGIN CERTIFICATE-----\nMOCK SERVER CERTIFICATE FOR DEVELOPMENT\n-----END CERTIFICATE-----";
      await fs.writeFile(this.certPath, mockCert);

      // Create mock private key
      const mockKey =
        "-----BEGIN PRIVATE KEY-----\nMOCK PRIVATE KEY FOR DEVELOPMENT\n-----END PRIVATE KEY-----";
      await fs.writeFile(this.keyPath, mockKey);

      // Create mock PEM file
      await fs.writeFile(this.pemPath, mockKey + mockCert);

      logger.info("Development certificates created successfully");
      return true;
    } catch (error) {
      logger.error(
        `Failed to create development certificates: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Check if certificates exist and are valid
   * @returns {Promise<boolean>} True if certificates exist
   */
  async certificatesExist() {
    try {
      await Promise.all([
        fs.access(this.caPath),
        fs.access(this.certPath),
        fs.access(this.keyPath),
      ]);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get certificate paths for use by other services
   * @returns {Object} Object containing certificate paths
   */
  getCertificatePaths() {
    return {
      caPath: this.caPath,
      certPath: this.certPath,
      keyPath: this.keyPath,
      pemPath: this.pemPath,
    };
  }
}

module.exports = new CertificateService();
