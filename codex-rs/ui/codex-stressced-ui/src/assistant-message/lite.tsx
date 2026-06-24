import React from "react";

export type AssistantMessageProps = {
  content: string;
  streaming?: boolean;
};

export const assistantMessagePreserveWhitespace = true;

const AssistantMessage = React.memo(function AssistantMessage({
  content,
}: AssistantMessageProps) {
  return content;
}, (previous, next) => previous.content === next.content);

export default AssistantMessage;
