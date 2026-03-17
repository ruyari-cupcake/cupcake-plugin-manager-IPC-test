// @ts-nocheck
/**
 * companion-installer.js — Manager가 다른 CPM 플러그인을 설치/업데이트하는 유틸리티
 *
 * RisuAI V3 제약:
 * - setDatabase({plugins: [...]}) 로 플러그인 설치 가능 (사용자 확인 다이얼로그 필요)
 * - V3.0 API 플러그인만 설치 가능
 * - eval/Function 사용 불가 — 코드는 RisuAI 플러그인 로더가 iframe에서 실행
 *
 * 사용 시나리오:
 * 1. Manager가 업데이트 서버에서 최신 플러그인 목록/코드를 fetch
 * 2. 사용자가 원하는 플러그인만 선택하여 설치
 * 3. RisuAI의 내장 @update-url 메커니즘으로 후속 업데이트 자동 체크
 */

import { getRisu } from './ipc-protocol.js';

/**
 * 현재 설치된 플러그인 목록 조회
 * @returns {Promise<Array<{name:string, versionOfPlugin?:string, enabled?:boolean, updateURL?:string}>>}
 */
export async function getInstalledPlugins() {
    const Risu = getRisu();
    if (!Risu?.getDatabase) return [];
    try {
        const db = await Risu.getDatabase(['plugins']);
        return (db?.plugins || []).map(p => ({
            name: p.name,
            versionOfPlugin: p.versionOfPlugin || '0.0.0',
            enabled: p.enabled !== false,
            updateURL: p.updateURL || '',
        }));
    } catch (e) {
        console.warn('[CPM Companion] Failed to list plugins:', e);
        return [];
    }
}

/**
 * 플러그인 코드를 RisuAI에 설치 요청
 *
 * 내부적으로 setDatabase({plugins: [newPlugin]}) 호출 →
 * RisuAI가 사용자에게 확인 다이얼로그를 보여주고, 승인 시 설치됨.
 *
 * @param {string} code - 설치할 플러그인의 전체 JS 코드
 * @param {object} [opts] - 옵션
 * @param {string} [opts.expectedName] - 설치 후 검증할 플러그인 이름
 * @returns {Promise<{success:boolean, message:string}>}
 */
export async function installCompanionPlugin(code, _opts = {}) {
    const Risu = getRisu();
    if (!Risu?.getDatabase || !Risu?.setDatabase) {
        return { success: false, message: 'RisuAI API (getDatabase/setDatabase) unavailable' };
    }

    // 코드에서 메타데이터 파싱
    const nameMatch = code.match(/\/\/@name\s+(.+)/);
    const versionMatch = code.match(/\/\/@version\s+(\S+)/);
    const apiMatch = code.match(/\/\/@api\s+(\S+)/);

    if (!nameMatch) {
        return { success: false, message: 'Plugin code missing //@name header' };
    }
    if (!apiMatch || apiMatch[1] !== '3.0') {
        return { success: false, message: 'Only API 3.0 plugins can be installed' };
    }

    const pluginName = nameMatch[1].trim();
    const pluginVersion = versionMatch ? versionMatch[1].trim() : '0.0.0';

    // 이미 설치되어있는지 확인
    const installed = await getInstalledPlugins();
    const existing = installed.find(p => p.name === pluginName);
    if (existing && existing.versionOfPlugin === pluginVersion) {
        return { success: false, message: `${pluginName} v${pluginVersion} already installed` };
    }

    // @arg 파싱
    const argMeta = {};
    const argRegex = /\/\/@arg\s+(\S+)\s+"([^"]+)"\s+(\S+)/g;
    let m;
    while ((m = argRegex.exec(code)) !== null) {
        argMeta[m[1]] = { label: m[2], type: m[3] };
    }

    // @update-url 파싱
    const updateUrlMatch = code.match(/\/\/@update-url\s+(\S+)/);
    const updateURL = updateUrlMatch ? updateUrlMatch[1].trim() : '';

    // @display-name 파싱
    const displayMatch = code.match(/\/\/@display-name\s+(.+)/);
    const displayName = displayMatch ? displayMatch[1].trim() : pluginName;

    // RisuPlugin 객체 구성
    const newPlugin = {
        name: pluginName,
        displayName,
        script: code,
        version: '3.0',
        versionOfPlugin: pluginVersion,
        updateURL,
        enabled: true,
        arguments: {},
        realArg: {},
        argMeta,
        customLink: [],
    };

    try {
        // setDatabase가 내부적으로 handlePluginInstallViaPlugin을 호출
        // → 사용자 확인 다이얼로그 표시 → 승인 시 설치
        await Risu.setDatabase({ plugins: [newPlugin] });

        // 설치 확인
        const afterInstall = await getInstalledPlugins();
        const found = afterInstall.find(p => p.name === pluginName);
        if (found) {
            return { success: true, message: `${pluginName} v${pluginVersion} installed successfully` };
        }
        // 사용자가 거부한 경우
        return { success: false, message: `Installation of ${pluginName} was declined by user` };
    } catch (e) {
        return { success: false, message: `Installation failed: ${e.message || e}` };
    }
}

/**
 * URL에서 플러그인 코드를 다운로드하여 설치
 *
 * @param {string} url - 플러그인 JS 코드 URL
 * @param {object} [opts] - installCompanionPlugin 옵션
 * @returns {Promise<{success:boolean, message:string}>}
 */
export async function downloadAndInstallPlugin(url, opts = {}) {
    const Risu = getRisu();
    try {
        let code;
        if (Risu?.nativeFetch) {
            const res = await Risu.nativeFetch(url, { method: 'GET' });
            if (!res.ok) return { success: false, message: `Download failed: HTTP ${res.status}` };
            code = typeof res.data === 'string' ? res.data : await res.text?.() || String(res.data);
        } else {
            const res = await fetch(url);
            if (!res.ok) return { success: false, message: `Download failed: HTTP ${res.status}` };
            code = await res.text();
        }

        if (!code || code.length < 50) {
            return { success: false, message: 'Downloaded code is too short or empty' };
        }

        return await installCompanionPlugin(code, opts);
    } catch (e) {
        return { success: false, message: `Download error: ${e.message || e}` };
    }
}
