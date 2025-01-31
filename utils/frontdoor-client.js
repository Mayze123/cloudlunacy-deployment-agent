const axios = require("axios");
const logger = require("./logger");

class FrontdoorClient {
  constructor() {
    this.baseUrl = process.env.FRONTDOOR_API_URL;
    this.token = process.env.FRONTDOOR_API_TOKEN;
  }

  async createSubdomain(subdomain) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/frontdoor/add-subdomain`,
        {
          subdomain: `${subdomain}.${process.env.FRONTDOOR_SUBDOMAIN_BASE}`,
          targetIp: process.env.PUBLIC_IP || (await this.getPublicIp()),
        },
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error(
        "Subdomain creation failed:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async getPublicIp() {
    const response = await axios.get("https://api.ipify.org?format=json");
    return response.data.ip;
  }
}

module.exports = new FrontdoorClient();
