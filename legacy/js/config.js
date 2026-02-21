// ─── CONFIGURAÇÃO GLOBAL ──────────────────────────────────────
// Chaves e constantes da aplicação.
// Em produção, mover para variáveis de ambiente / backend proxy.
const CONFIG = {
  OPENAI_API_KEY:   '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',
  TT_BASE:          'https://api.tastyworks.com',
  TT_CLIENT_ID:     '4b3f87dc-da7f-409f-aa61-3a340d57a180',
  TT_CLIENT_SECRET: '481802e13b4ba2b26049cc85738404821fc132f7',
  TT_REFRESH_TOKEN: 'eyJhbGciOiJFZERTQSIsInR5cCI6InJ0K2p3dCIsImtpZCI6InNHa0N1N2RQUlRPNjZZallkSXhGd2EzMXp2VEo2bDlqV1R3a0Q2M2NwNHMiLCJqa3UiOiJodHRwczovL2ludGVyaW9yLWFwaS5hcjIudGFzdHl0cmFkZS5zeXN0ZW1zL29hdXRoL2p3a3MifQ.eyJpc3MiOiJodHRwczovL2FwaS50YXN0eXRyYWRlLmNvbSIsInN1YiI6IlU0MWZkNjQzNC1lNjE1LTRjOTYtYWE3YS0yZDI2ZGJiOWFlNzkiLCJpYXQiOjE3NzEyODU4NTgsImF1ZCI6IjRiM2Y4N2RjLWRhN2YtNDA5Zi1hYTYxLTNhMzQwZDU3YTE4MCIsImdyYW50X2lkIjoiR2FhMmMzOTIzLWI5ZDAtNDM3Zi1iOTg4LWQzMmIyNWRmMWEyNCIsInNjb3BlIjoicmVhZCB0cmFkZSJ9.kjmqXIyibKnUM4s-clPILJLGzDg1t9swARQD0JJAn_GTtOHe-GUKMSHPcuJ9Jt54Z4XDgxz-TDhaMLMPX_rtAQ',
  REFRESH_INTERVAL: 30000, // ms entre atualizações automáticas
};
