import React from 'react';

export interface ArtworkData {
  data: Uint8Array;
  format: string;
}

export interface Song {
  id?: number; // Primary key, optional because it's auto-incrementing
  fileBlob: Blob;
  title: string;
  artist: string;
  album: string;
  artwork?: ArtworkData;
  duration: number;
  rating?: number;
}

export interface Playlist {
  id?: number;
  name: string;
  songIds: number[];
}

export interface MenuItem {
  label: string;
  subtext?: string;
  action: () => void;
  hasArrow?: boolean;
  ratingDisplay?: React.ReactNode;
  songId?: number; // Add songId for robust actions
}

export interface BounceGameState {
  gameState: 'idle' | 'playing' | 'paused' | 'game-over';
  score: number;
  highScore: number;
  paddleAngle: number; // In degrees (0-360)
  ball: {
    x: number; // Position from center (-50 to 50)
    y: number; // Position from center (-50 to 50)
    dx: number; // Velocity
    dy: number; // Velocity
  };
  ballSpeed: number;
}


// --- Focus App Types ---

export interface FocusSession {
  id?: number;
  endTimestamp: number; // when the session was completed
  durationMinutes: number;
  type: 'work' | 'shortBreak' | 'longBreak';
}

export interface FocusSettings {
  id: 0; // Should always be 0 for the single settings object
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  longBreakInterval: number; // work intervals before a long break
  tickingSound: boolean;
  fullscreenBreak: boolean;
  autoStart: boolean;
}

export interface FocusState {
  isActive: boolean;
  sessionType: 'work' | 'shortBreak' | 'longBreak' | 'idle';
  timeRemaining: number; // in seconds
  workIntervalsInCycle: number; // number of work intervals completed in the current cycle of longBreakInterval
}

export interface TodayStats {
    workIntervals: number;
    totalTime: number; // in minutes
}
