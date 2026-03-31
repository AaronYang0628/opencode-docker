const BRIDGE_START_TIME = Date.now();

const sessionMap = new Map();
const sessionQueue = new Map();

const stats = {
  totalRequests: 0,
  successRequests: 0,
  errorRequests: 0,
  timeoutRequests: 0,
};

const sessionMetrics = new Map();

module.exports = {
  BRIDGE_START_TIME,
  sessionMap,
  sessionQueue,
  stats,
  sessionMetrics,
};
