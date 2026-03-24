const NEWLINE = "\n";

function encodeMessage(message) {
  return JSON.stringify(message) + NEWLINE;
}

function createLineParser(onMessage, onError) {
  let buffer = "";

  return (chunk) => {
    buffer += chunk.toString("utf8");

    while (true) {
      const newlineIndex = buffer.indexOf(NEWLINE);
      if (newlineIndex < 0) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        const parsed = JSON.parse(line);
        onMessage(parsed);
      } catch (error) {
        onError(error);
      }
    }
  };
}

module.exports = {
  encodeMessage,
  createLineParser,
};
