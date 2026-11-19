/** Turns an Axios error into a user-friendly message. */
export function getErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return fallback;
  if (error.code === 'ECONNABORTED') return 'The server took too long to respond.';
  if (!error.response) return 'Cannot reach the server. Check your connection and that the backend is running.';
  const apiError = error.response.data?.error;
  if (apiError?.details && Array.isArray(apiError.details) && apiError.details[0]?.message) {
    return `${apiError.message}: ${apiError.details.map((d) => d.message).join(', ')}`;
  }
  return apiError?.message || fallback;
}

export const getErrorCode = (error) => error?.response?.data?.error?.code;

/** Network failure or timeout: the request may or may not have reached the server. */
export const isNetworkOrTimeout = (error) => Boolean(error) && !error.response;
