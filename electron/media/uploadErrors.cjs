const MEDIA_UPLOAD_ERROR_PREFIX = "MEDIA_UPLOAD_ERROR::";

function createMediaUploadError(code, details = {}) {
  const payload = {
    code,
    details,
  };
  const error = new Error(`${MEDIA_UPLOAD_ERROR_PREFIX}${JSON.stringify(payload)}`);
  error.name = "MediaUploadError";
  return error;
}

function isMediaUploadError(error) {
  return (
    error instanceof Error &&
    error.name === "MediaUploadError" &&
    typeof error.message === "string" &&
    error.message.startsWith(MEDIA_UPLOAD_ERROR_PREFIX)
  );
}

module.exports = {
  MEDIA_UPLOAD_ERROR_PREFIX,
  createMediaUploadError,
  isMediaUploadError,
};
