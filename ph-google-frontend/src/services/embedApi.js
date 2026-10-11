import { api } from './apiClient';

/**
 * Asks the backend whether a page may be shown in a frame.
 *
 * A page cannot tell, from inside the browser, a frame its site refused from
 * one that loaded, so the server reads the site's headers and answers.
 *
 * @param {string} url
 * @returns {Promise<'ok'|'blocked'>} 'ok' also when it could not be found
 *          out: the frame is then simply tried.
 */
export async function checkEmbeddable(url) {
  try {
    const data = await api.get('/embed-check', { params: { url }, auth: false });
    return data && data.embeddable === false ? 'blocked' : 'ok';
  } catch {
    return 'ok';
  }
}
