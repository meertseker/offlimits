/** An error with an HTTP status and a short machine code; the room server turns it into a JSON response. */
export class RoomError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {object} [data]
   */
  constructor(status, code, message, data) {
    super(message);
    this.name = 'RoomError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}
