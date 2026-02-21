import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface AnalysisResultProps {
  text: string
  isStreaming?: boolean
}

export function AnalysisResult({ text, isStreaming = false }: AnalysisResultProps) {
  if (!text) return null

  return (
    <div className="prose prose-invert max-w-none text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-base font-display font-bold text-text-primary mb-2 mt-4 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-display font-semibold text-text-primary mb-1.5 mt-3 first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-[#00ff88] mb-1 mt-2">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-text-secondary mb-2 last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="space-y-1 mb-2 pl-4">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="space-y-1 mb-2 pl-4 list-decimal">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-text-secondary marker:text-[#00ff88]">{children}</li>
          ),
          strong: ({ children }) => (
            <strong className="text-text-primary font-semibold">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="text-[#00ff88] not-italic">{children}</em>
          ),
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-')
            return isBlock ? (
              <code className="block bg-bg-elevated border border-border-subtle rounded p-3 text-xs text-text-primary font-mono overflow-x-auto my-2">
                {children}
              </code>
            ) : (
              <code className="bg-bg-elevated px-1 py-0.5 rounded text-xs text-[#00ff88] font-mono">
                {children}
              </code>
            )
          },
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[#00ff88]/40 pl-3 my-2 text-text-secondary">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-border-subtle my-3" />,
        }}
      >
        {text}
      </ReactMarkdown>
      {isStreaming && (
        <span className="inline-block w-1 h-4 bg-[#00ff88] ml-0.5 animate-blink align-middle" />
      )}
    </div>
  )
}
