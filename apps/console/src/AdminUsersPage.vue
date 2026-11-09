<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
const { users, me, setUserStatus } = inject<ConsoleContext>('console')!
</script>
<template>
  <div class="card">
    <el-table :data="users"
      ><el-table-column prop="email" label="用户邮箱" min-width="230" /><el-table-column
        prop="role"
        label="角色"
      /><el-table-column prop="status" label="状态" /><el-table-column label="操作"
        ><template #default="{ row }"
          ><el-button
            text
            :type="row.status === 'active' ? 'danger' : 'primary'"
            :disabled="row.id === me?.id || row.role === 'super_admin'"
            @click="setUserStatus(row)"
            >{{ row.status === 'active' ? '禁用' : '启用' }}</el-button
          ></template
        ></el-table-column
      ></el-table
    >
  </div>
</template>
