<script setup lang="ts">
defineProps<{
  headline: string
  description: string
}>()
</script>

<template>
  <div class="auth-page">
    <aside class="auth-art">
      <div class="auth-brand">
        <img class="auth-brand-symbol" src="/remote-code-logo.png" alt="" width="40" height="40" />
        Remote Code MCP
      </div>
      <div class="auth-hero">
        <div class="auth-kicker">SECURE REMOTE DEVELOPMENT</div>
        <h1>{{ headline }}</h1>
        <p>{{ description }}</p>
        <div class="auth-trust">
          <span class="auth-trust-dot"></span> 代码留在本机 · 权限由你掌控
        </div>
      </div>
      <div class="auth-art-footer">REMOTE CODE PLATFORM · v0.1.0</div>
    </aside>
    <section class="auth-form">
      <div class="auth-box">
        <slot />
      </div>
    </section>
  </div>
</template>
