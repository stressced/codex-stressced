import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./full.css";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const STREAMING_MARKDOWN_THROTTLE_MS = 200;

export type AssistantMessageProps = {
  content: string;
  streaming?: boolean;
};

export const assistantMessagePreserveWhitespace = false;

function useThrottledText(text: string, enabled: boolean, delayMs: number): string {
  const [throttled, setThrottled] = useState(text);
  const latestRef = useRef(text);
  const timerRef = useRef<number | null>(null);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    latestRef.current = text;

    if (!enabled) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastUpdateRef.current = performance.now();
      setThrottled(text);
      return;
    }

    const flush = () => {
      timerRef.current = null;
      lastUpdateRef.current = performance.now();
      setThrottled(latestRef.current);
    };
    const elapsed = performance.now() - lastUpdateRef.current;

    if (elapsed >= delayMs) {
      flush();
    } else if (timerRef.current === null) {
      timerRef.current = window.setTimeout(flush, delayMs - elapsed);
    }
  }, [text, enabled, delayMs]);

  useEffect(() => (
    () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    }
  ), []);

  return enabled ? throttled : text;
}

const MarkdownRenderer = React.memo(function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
      {content}
    </ReactMarkdown>
  );
});

const AssistantMessage = React.memo(function AssistantMessage({
  content,
  streaming,
}: AssistantMessageProps) {
  const renderedContent = useThrottledText(
    content,
    Boolean(streaming),
    STREAMING_MARKDOWN_THROTTLE_MS,
  );

  return (
    <div className="markdown-body">
      <MarkdownRenderer content={renderedContent} />
    </div>
  );
});

export default AssistantMessage;
