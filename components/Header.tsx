

import React from 'react';
// FIX: Corrected the import path for ChartIcon to be a relative path.
import { ChartIcon } from './Icons';

export const Header: React.FC = () => {
  return (
    <header className="bg-bg-light shadow-sm border-b border-border-color flex-shrink-0">
      <div className="container mx-auto px-3 md:px-6 py-1.5 flex items-center justify-between">
        <div className="flex items-center">
          <ChartIcon className="h-5 w-5 text-brand-primary" />
          <h1 className="ml-2 text-sm md:text-base font-bold text-text-primary tracking-tight">
            GZBot 🚀
          </h1>
          <span className="ml-2 bg-brand-primary/80 text-[10px] font-semibold text-white px-1.5 py-0.5 rounded-full">
            v52 IGNITION
          </span>
        </div>
      </div>
    </header>
  );
};