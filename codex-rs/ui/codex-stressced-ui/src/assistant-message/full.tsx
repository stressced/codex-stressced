import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./full.css";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

export type AssistantMessageProps = {
  content: string;
  streaming?: boolean;
};

export const assistantMessagePreserveWhitespace = false;

const MarkdownRenderer = React.memo(function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
      {content}
    </ReactMarkdown>
  );
});

const AssistantMessage = React.memo(function AssistantMessage({
  content,
}: AssistantMessageProps) {
  return (
    <div className="markdown-body">
      <MarkdownRenderer content={content} />
    </div>
  );
});

export default AssistantMessage;
