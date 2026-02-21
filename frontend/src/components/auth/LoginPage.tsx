import { useState, type FormEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { UseAuth } from '../../hooks/useAuth'

interface LoginPageProps {
  auth: UseAuth
}

export function LoginPage({ auth }: LoginPageProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    await auth.login(email, password)
  }

  return (
    <div className="min-h-screen bg-bg-base flex flex-col items-center justify-center px-4">
      {/* Background grid */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(0,255,136,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,136,1) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      {/* Glow */}
      <div className="fixed top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full bg-[#00ff88]/5 blur-3xl pointer-events-none" />

      <motion.div
        className="relative w-full max-w-sm"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      >
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#00ff88]/10 border border-[#00ff88]/20 mb-4">
            <span className="text-[#00ff88] text-xl font-extrabold font-display">S</span>
          </div>
          <h1 className="font-display text-3xl">
            <span className="font-extrabold text-text-primary">SPY </span>
            <span className="font-extrabold text-[#00ff88]">DASH</span>
          </h1>
          <p className="text-text-muted text-xs mt-2 tracking-wide">
            Dashboard de opções em tempo real
          </p>
        </div>

        {/* Card */}
        <div className="card p-6">
          <h2 className="text-sm font-display font-semibold text-text-primary mb-1">
            Entrar
          </h2>
          <p className="text-[11px] text-text-muted mb-5">
            Acesso restrito — use o email e senha fornecidos
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <div>
              <label className="block text-[11px] text-text-secondary mb-1.5 tracking-wide">
                EMAIL
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@exemplo.com"
                autoComplete="email"
                required
                className="
                  w-full bg-bg-elevated border border-border-subtle rounded-lg
                  px-3 py-2.5 text-sm font-mono text-text-primary
                  placeholder:text-text-muted
                  focus:outline-none focus:border-[#00ff88]/40 focus:ring-1 focus:ring-[#00ff88]/20
                  transition-colors
                "
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-[11px] text-text-secondary mb-1.5 tracking-wide">
                SENHA
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                  className="
                    w-full bg-bg-elevated border border-border-subtle rounded-lg
                    px-3 py-2.5 pr-10 text-sm font-mono text-text-primary
                    placeholder:text-text-muted
                    focus:outline-none focus:border-[#00ff88]/40 focus:ring-1 focus:ring-[#00ff88]/20
                    transition-colors
                  "
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                >
                  {showPassword ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Error */}
            <AnimatePresence>
              {auth.error && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="flex items-center gap-2 text-xs text-red-400 bg-red-400/5 border border-red-400/20 rounded-lg px-3 py-2">
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                    {auth.error}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Submit */}
            <button
              type="submit"
              disabled={auth.isLoading || !email || !password}
              className="
                w-full py-2.5 rounded-lg text-sm font-semibold tracking-wide
                transition-all duration-200 active:scale-[0.98]
                disabled:opacity-50 disabled:cursor-not-allowed
                bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30
                hover:bg-[#00ff88]/20 hover:border-[#00ff88]/50
                disabled:hover:bg-[#00ff88]/10 disabled:hover:border-[#00ff88]/30
              "
            >
              {auth.isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  Entrando...
                </span>
              ) : (
                'Entrar'
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-[10px] text-text-muted mt-5">
          Autenticado via Supabase Auth
        </p>
      </motion.div>
    </div>
  )
}
