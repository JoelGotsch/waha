import { Injectable } from '@nestjs/common';
import { HealthCheckResult } from '@nestjs/terminus';

import { WAHAHealthCheckService } from '../abc/WAHAHealthCheckService';

@Injectable()
export class WAHAHealthCheckServiceCore extends WAHAHealthCheckService {
  async check(): Promise<HealthCheckResult> {
    const sessions = this.sessionManager.sessions;
    const sessionCount = sessions.length;
    const activeSessions = sessions.filter(s => s.status === 'WORKING').length;

    return {
      status: 'ok',
      info: {
        sessions: {
          status: 'up',
          total: sessionCount,
          active: activeSessions,
        },
      },
      error: {},
      details: {
        sessions: {
          status: 'up',
          total: sessionCount,
          active: activeSessions,
        },
      },
    };
  }
}
