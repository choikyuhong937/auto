
// components/AiCoreConfig.tsx
import React from 'react';
// FIX: Corrected import path
import type { AiCoreConfig as AiCoreConfigType, BotState } from '../types';
import { SlidersIcon, QuestionMarkCircleIcon, RobotIcon, HistoryIcon, SendIcon } from './Icons';

interface AiCoreConfigProps {
    config: AiCoreConfigType;
    botState: BotState;
    // FIX: Corrected typo from AiCoreCodeConfigType to AiCoreConfigType.
    onConfigChange: (newConfig: AiCoreConfigType) => void;
    disabled?: boolean;
}

const ConfigInput: React.FC<{
    label: string;
    value: string | number;
    onChange: (value: string) => void;
    type?: 'text' | 'number';
    disabled?: boolean;
    placeholder?: string;
    tooltip?: string;
}> = ({ label, value, onChange, type = 'text', disabled, placeholder, tooltip }) => (
    <div>
        <div className="flex justify-between items-center text-xs text-text-secondary mb-1">
            <div className="flex items-center gap-1.5">
                <label>{label}</label>
                {tooltip && (
                    <div className="group relative">
                        <QuestionMarkCircleIcon className="w-4 h-4 text-text-secondary cursor-help"/>
                        <div className="absolute bottom-full mb-2 -left-1/2 transform translate-x-1/4 w-64 p-2 bg-bg-dark border border-border-color rounded-md text-xs text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                            {tooltip}
                        </div>
                    </div>
                )}
            </div>
        </div>
        <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={placeholder}
            className="w-full bg-bg-dark border border-border-color rounded-md p-2 text-sm focus:ring-2 focus:ring-brand-primary focus:outline-none transition-colors disabled:opacity-50"
        />
    </div>
);


const ConfigSelect: React.FC<{
    label: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    options: { value: string; label: string }[];
    tooltip?: string;
}> = ({ label, value, onChange, disabled, options, tooltip }) => (
    <div>
        <div className="flex justify-between items-center text-xs text-text-secondary mb-1">
            <div className="flex items-center gap-1.5">
                <label>{label}</label>
                {tooltip && (
                    <div className="group relative">
                        <QuestionMarkCircleIcon className="w-4 h-4 text-text-secondary cursor-help"/>
                        <div className="absolute bottom-full mb-2 -left-1/2 transform translate-x-1/4 w-64 p-2 bg-bg-dark border border-border-color rounded-md text-xs text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                            {tooltip}
                        </div>
                    </div>
                )}
            </div>
        </div>
        <div className="relative">
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className="w-full bg-bg-dark border border-border-color rounded-md p-2 text-sm focus:ring-2 focus:ring-brand-primary focus:outline-none appearance-none"
            >
                {options.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-400">
                <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
            </div>
        </div>
    </div>
);

const ConfigTextarea: React.FC<{
    label: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
    tooltip?: string;
    rows?: number;
}> = ({ label, value, onChange, disabled, placeholder, tooltip, rows = 2 }) => (
    <div>
        <div className="flex justify-between items-center text-xs text-text-secondary mb-1">
            <div className="flex items-center gap-1.5">
                <label>{label}</label>
                {tooltip && (
                    <div className="group relative">
                        <QuestionMarkCircleIcon className="w-4 h-4 text-text-secondary cursor-help"/>
                        <div className="absolute bottom-full mb-2 -left-1/2 transform translate-x-1/4 w-64 p-2 bg-bg-dark border border-border-color rounded-md text-xs text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                            {tooltip}
                        </div>
                    </div>
                )}
            </div>
        </div>
        <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={placeholder}
            rows={rows}
            className="w-full bg-bg-dark border border-border-color rounded-md p-2 text-sm focus:ring-2 focus:ring-brand-primary focus:outline-none transition-colors disabled:opacity-50 resize-none"
        />
    </div>
);

const Slider: React.FC<{
    label: string;
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step: number;
    unit?: string;
    disabled?: boolean;
    tooltip?: string;
}> = ({ label, value, onChange, min, max, step, unit = '', disabled, tooltip }) => (
    <div>
        <div className="flex justify-between items-center text-xs text-text-secondary mb-1">
            <div className="flex items-center gap-1.5">
                <label>{label}</label>
                {tooltip && (
                    <div className="group relative">
                        <QuestionMarkCircleIcon className="w-4 h-4 text-text-secondary cursor-help"/>
                        <div className="absolute bottom-full mb-2 -left-1/2 transform translate-x-1/4 w-64 p-2 bg-bg-dark border border-border-color rounded-md text-xs text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                            {tooltip}
                        </div>
                    </div>
                )}
            </div>
            <span className="font-mono text-brand-primary font-bold">{value === 0 ? 'Off' : `${value}${unit}`}</span>
        </div>
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            disabled={disabled}
            className="w-full h-2 bg-bg-dark rounded-lg appearance-none cursor-pointer border border-border-color range-slider"
        />
    </div>
);

export const AiCoreConfig: React.FC<AiCoreConfigProps> = ({ config, botState, onConfigChange, disabled }) => {

    const handleGenericChange = (field: keyof AiCoreConfigType, value: any) => {
        onConfigChange({ ...config, [field]: value });
    };

    return (
        <div className="space-y-4 animate-fade-in">
             <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 {/* Left Column */}
                <div className="p-4 bg-bg-light rounded-lg border border-border-color/50 space-y-4">
                     <h3 className="text-base font-bold flex items-center gap-2">
                        <SlidersIcon className="w-5 h-5"/>
                        AI 거래 환경 설정
                    </h3>

                    <div className="pt-2 border-t border-border-color/50 space-y-4">
                         <ConfigTextarea
                            label="분석 제외 목록"
                            value={config.exclusionList}
                            onChange={(v) => handleGenericChange('exclusionList', v)}
                            disabled={disabled}
                            placeholder="DOGEUSDT,SHIBUSDT..."
                            tooltip="쉼표(,)로 구분하여 분석에서 제외할 코인 심볼 목록을 입력하세요."
                        />
                         <ConfigTextarea
                            label="AI 집중 분석 종목 (헌터 모드)"
                            value={config.focusList}
                            onChange={(v) => handleGenericChange('focusList', v.toUpperCase())}
                            disabled={disabled}
                            placeholder="BTCUSDT,ETHUSDT..."
                            tooltip="쉼표(,)로 구분하여 AI가 집중적으로 분석할 1~2개 종목을 입력하세요. 입력 시 AI는 다른 종목 스캔을 멈추고 이 종목들의 거대 추세 시작점을 끈질기게 추적합니다."
                        />
                    </div>

                    <div className="pt-2 border-t border-border-color/50 space-y-4">
                        <Slider
                            label="스캔 상위 종목 수"
                            value={config.scanTopN ?? 10}
                            onChange={(v) => handleGenericChange('scanTopN', v)}
                            min={0}
                            max={50}
                            step={5}
                            unit="개"
                            disabled={disabled}
                            tooltip="변동성 상위 N개 종목만 스캔합니다. 0=무제한 (변동≥3% 전체). 적을수록 집중도 높고 API 부하 낮음."
                        />
                        <Slider
                            label="포지션 비중"
                            value={config.baseSizePercent ?? 20}
                            onChange={(v) => handleGenericChange('baseSizePercent', v)}
                            min={5}
                            max={50}
                            step={5}
                            unit="%"
                            disabled={disabled}
                            tooltip="각 포지션에 투입할 자본 비중(%). 20%×5포지션=100%. 높을수록 집중, 낮을수록 분산."
                        />
                        <Slider
                            label="최대 동시 포지션"
                            value={config.maxPositions ?? 12}
                            onChange={(v) => handleGenericChange('maxPositions', v)}
                            min={1}
                            max={20}
                            step={1}
                            unit="개"
                            disabled={disabled}
                            tooltip="동시에 보유할 수 있는 최대 포지션 수. 적을수록 집중, 많을수록 분산."
                        />
                    </div>
                </div>
                {/* Right Column */}
                <div className="p-4 bg-bg-light rounded-lg border border-border-color/50 space-y-4">
                    <h3 className="text-base font-bold flex items-center gap-2">
                        <SendIcon className="w-5 h-5"/>
                        알림 설정 (Telegram)
                    </h3>
                    <ConfigInput
                        label="Telegram Bot Token"
                        value={config.telegramBotToken || ''}
                        onChange={(v) => handleGenericChange('telegramBotToken', v)}
                        disabled={disabled}
                        placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
                        tooltip="BotFather에게 받은 봇 토큰을 입력하세요. 알림을 받으려면 필수입니다."
                    />
                    <ConfigInput
                        label="Telegram Chat ID"
                        value={config.telegramChatId || ''}
                        onChange={(v) => handleGenericChange('telegramChatId', v)}
                        disabled={disabled}
                        placeholder="12345678"
                        tooltip="알림을 받을 채팅방의 ID입니다. @userinfobot 등을 통해 확인할 수 있습니다."
                    />
                    
                    <Slider
                        label="정기 자산 보고 간격 (시간)"
                        value={config.telegramReportInterval || 0}
                        onChange={(v) => handleGenericChange('telegramReportInterval', v)}
                        min={0}
                        max={24}
                        step={1}
                        unit="시간"
                        disabled={disabled}
                        tooltip="지정된 시간 간격마다 봇이 자동으로 자산 현황(PnL, 승률 등)을 텔레그램으로 전송합니다. 0으로 설정하면 비활성화됩니다."
                    />

                    <div className="pt-4 border-t border-border-color/50 space-y-2 text-xs">
                        <h4 className="font-bold text-text-primary">리스크 및 로직 정보</h4>
                        <p className="text-text-secondary">다음 설정은 AI 자율 운영 모드에 따라 시스템에 의해 고정되거나 동적으로 결정됩니다:</p>
                        <div className="pl-4">
                            <p>• **거래당 리스크:** <span className="font-semibold text-amber-400">AI가 동적으로 결정</span></p>
                            <p>• **리스크 성향:** <span className="font-semibold text-amber-400">공격적 (Aggressive)</span></p>
                            <p>• **포지션 모드:** <span className="font-semibold text-amber-400">단방향 (One-Way)</span></p>
                            <p>• **손실 후 쿨다운:** <span className="font-semibold text-amber-400">비활성화</span></p>
                        </div>
                    </div>
                </div>
            </div>
             <style>{`
                .range-slider::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 16px;
                    height: 16px;
                    background: #00A8FF;
                    cursor: pointer;
                    border-radius: 50%;
                }
                .range-slider::-moz-range-thumb {
                    width: 16px;
                    height: 16px;
                    background: #00A8FF;
                    cursor: pointer;
                    border-radius: 50%;
                }
                .text-xxs { font-size: 0.65rem; line-height: 0.85rem; }
            `}</style>
        </div>
    );
};
