const packageJson = require("../../package.json");

const APP_NAME = "Messly";
const APP_VERSION = String(packageJson.version ?? "0.0.5").trim() || "0.0.5";
const APP_ID = "com.messly.app";
const WINDOWS_APP_USER_MODEL_ID = APP_ID;
const EXECUTABLE_NAME = "Messly";

module.exports = {
  APP_NAME,
  APP_VERSION,
  APP_ID,
  WINDOWS_APP_USER_MODEL_ID,
  EXECUTABLE_NAME,
};
