
import Dexie from 'dexie';
import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import * as mmb from 'music-metadata-browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { Song, MenuItem, ArtworkData, Playlist, BounceGameState, FocusSettings, FocusState, FocusSession, TodayStats } from './types';
import { PlayIcon, PauseIcon, NextIcon, PrevIcon } from './constants';

// --- Type Augmentation for Folder Upload ---
declare module 'react' {
  interface InputHTMLAttributes<T> {
    directory?: string;
    webkitdirectory?: string;
  }
}

// --- Types ---
type RepeatMode = 'off' | 'all' | 'one';
type NowPlayingMode = 'volume' | 'rating';


// --- Constants ---
const SUPPORTED_EXTENSIONS = ['.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg'];

// --- Color Customization Constants ---
const BODY_COLORS = [
    { name: 'White', class: 'bg-gradient-to-b from-gray-100 to-gray-300' },
    { name: 'Black', class: 'bg-gradient-to-b from-gray-800 to-black' },
    { name: 'Silver', class: 'bg-gradient-to-b from-gray-400 to-gray-600' },
    { name: 'Blue', class: 'bg-gradient-to-b from-blue-300 to-blue-500' },
    { name: 'Gold', class: 'bg-gradient-to-b from-yellow-300 to-yellow-500' },
    { name: 'Green', class: 'bg-gradient-to-b from-green-300 to-green-500' },
    { name: 'Lime', class: 'bg-gradient-to-b from-lime-300 to-lime-500' },
    { name: 'Pink', class: 'bg-gradient-to-b from-pink-300 to-pink-500' },
    { name: 'Purple', class: 'bg-gradient-to-b from-purple-300 to-purple-500' },
    { name: 'Red', class: 'bg-gradient-to-b from-red-400 to-red-600' },
];

const WHEEL_COLORS = [
    { name: 'Gray', class: 'bg-gray-800' },
    { name: 'Black', class: 'bg-black' },
    { name: 'Blue', class: 'bg-blue-800' },
    { name: 'Green', class: 'bg-green-700' },
    { name: 'Orange', class: 'bg-orange-700' },
    { name: 'Purple', class: 'bg-purple-800' },
    { name: 'Red', class: 'bg-red-700' },
];

const DEFAULT_COLORS = {
    body: BODY_COLORS[0].class,
    wheel: WHEEL_COLORS[0].class,
};

const DEFAULT_FOCUS_SETTINGS: FocusSettings = {
    id: 0,
    workMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    longBreakInterval: 4,
    tickingSound: false,
    fullscreenBreak: true,
    autoStart: true,
};

// --- Helpers ---
const formatTime = (timeInSeconds: number): string => {
  const totalSeconds = Math.floor(timeInSeconds);
  if (isNaN(totalSeconds) || totalSeconds < 0) return '0:00';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const getInitialBallVelocity = (speed: number) => {
    const angle = Math.random() * 2 * Math.PI;
    return {
        x: 0,
        y: 0,
        dx: Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
    };
};

// --- Custom Hooks ---

/**
 * A robust playback hook that handles the audio element and its state.
 */
const usePlayback = ({ onTrackEnd, repeatMode }: { onTrackEnd: () => void; repeatMode: RepeatMode }) => {
    const audioRef = useRef<HTMLAudioElement>(new Audio());
    const lastUrl = useRef<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    useEffect(() => {
        const audio = audioRef.current;
        audio.loop = repeatMode === 'one';
    }, [repeatMode]);

    useEffect(() => {
        const audio = audioRef.current;
        const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
        const handleLoadedMetadata = () => setDuration(audio.duration);
        const handleEnded = () => onTrackEnd();
        
        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('ended', handleEnded);
        return () => {
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('ended', handleEnded);
        };
    }, [onTrackEnd]);

    const play = useCallback((url: string) => {
        lastUrl.current = url;
        audioRef.current.src = url;
        audioRef.current.play().then(() => setIsPlaying(true)).catch(e => console.error("Playback failed", e));
    }, []);

    const pause = useCallback(() => {
        audioRef.current.pause();
        setIsPlaying(false);
    }, []);

    const resume = useCallback(() => {
        // If there's a valid source, just play. Using currentSrc is more reliable
        // than src, as src can be a page URL when empty.
        if (audioRef.current.currentSrc) {
            audioRef.current.play().then(() => setIsPlaying(true)).catch(e => console.error("Resume failed", e));
        } else if (lastUrl.current) {
            // If the source was cleared (by stop()), use the last known URL to replay.
            play(lastUrl.current);
        }
    }, [play]);
    
    const setVolume = useCallback((volume: number) => {
        audioRef.current.volume = volume;
    }, []);
    
    const seek = useCallback((time: number) => {
        audioRef.current.currentTime = time;
    }, []);

    const stop = useCallback(() => {
        const audio = audioRef.current;
        audio.pause();
        // Detach the media source. DO NOT call .load(), as it creates a new load request
        // which causes a race condition and the "interrupted by a new load request" error.
        audio.src = '';
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
    }, []);


    return { isPlaying, currentTime, duration, play, pause, resume, setVolume, seek, stop };
};

/**
 * A hook to manage the Media Session API for lock screen controls.
 */
const useMediaSession = ({ song, isPlaying, onPlay, onPause, onNext, onPrev }: {
    song?: Song;
    isPlaying: boolean;
    onPlay: () => void;
    onPause: () => void;
    onNext: () => void;
    onPrev: () => void;
}) => {
    useEffect(() => {
        if (!('mediaSession' in navigator)) return;
        const mediaSession = navigator.mediaSession;

        if (song) {
            let artworkUrl: string | undefined;
            if (song.artwork) {
                const blob = new Blob([song.artwork.data], { type: song.artwork.format });
                artworkUrl = URL.createObjectURL(blob);
            }
            mediaSession.metadata = new MediaMetadata({
                title: song.title,
                artist: song.artist,
                album: song.album,
                artwork: artworkUrl ? [{ src: artworkUrl, type: song.artwork.format }] : [],
            });
            // Cleanup the object URL when the song changes or component unmounts
            return () => {
                if (artworkUrl) URL.revokeObjectURL(artworkUrl);
            };
        } else {
            mediaSession.metadata = null;
        }
    }, [song]);

    useEffect(() => {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
        }
    }, [isPlaying]);
    
    useEffect(() => {
        if (!('mediaSession' in navigator)) return;
        const mediaSession = navigator.mediaSession;
        
        try {
            mediaSession.setActionHandler('play', onPlay);
            mediaSession.setActionHandler('pause', onPause);
            mediaSession.setActionHandler('nexttrack', onNext);
            mediaSession.setActionHandler('previoustrack', onPrev);
        } catch (error) {
            console.error("Failed to set media session handlers:", error);
        }

        return () => {
             try {
                mediaSession.setActionHandler('play', null);
                mediaSession.setActionHandler('pause', null);
                mediaSession.setActionHandler('nexttrack', null);
                mediaSession.setActionHandler('previoustrack', null);
             } catch (error) {
                 console.error("Failed to clear media session handlers:", error);
             }
        };
    }, [onPlay, onPause, onNext, onPrev]);
};


// --- Reusable Components (Memoized for Performance) ---

interface ScreenProps {
  children: React.ReactNode;
  title: string;
  isFlashing?: boolean;
}
const Screen = memo<ScreenProps>(({ children, title, isFlashing }) => (
  <div className="w-full h-1/2 bg-gray-900 rounded-t-lg p-1.5 shadow-inner shadow-black relative">
    <div className="h-full w-full bg-gradient-to-b from-[#d7e5f4] to-white rounded-sm overflow-hidden flex flex-col">
      <header className="w-full bg-gradient-to-b from-gray-200 to-gray-400 border-b border-gray-500 py-0.5 px-2 flex justify-between items-center shrink-0">
        <span className="font-bold text-sm text-gray-800 truncate pr-2">{title}</span>
        <div className="w-6 h-3 border-2 border-gray-800 rounded-sm flex items-center p-px flex-shrink-0">
          <div className="w-full h-full bg-green-400 rounded-xs"></div>
        </div>
      </header>
      <main className="flex-grow overflow-y-auto">{children}</main>
    </div>
    {isFlashing && <div className="absolute inset-1.5 rounded-sm bg-blue-400 pointer-events-none animate-flash-overlay"></div>}
  </div>
));

interface ClickWheelProps {
  onScroll: (direction: number) => void;
  onMenuClick: () => void;
  onPlayPauseClick: () => void;
  onNextClick: () => void;
  onPrevClick: () => void;
  onSelectClick: () => void;
  onSelectLongPress?: () => void;
  isPlaying: boolean;
  wheelClass: string;
}
const ClickWheel = memo<ClickWheelProps>(({ onScroll, onMenuClick, onPlayPauseClick, onNextClick, onPrevClick, onSelectClick, onSelectLongPress, isPlaying, wheelClass }) => {
  const wheelRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<number | null>(null);
  const scrollHandler = useRef(onScroll);
  scrollHandler.current = onScroll;

  const handleSelectMouseDown = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (onSelectLongPress) {
      longPressTimer.current = window.setTimeout(() => {
        onSelectLongPress();
        longPressTimer.current = null;
      }, 500);
    }
  };

  const handleSelectMouseUp = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
      onSelectClick();
    }
  };
  
  useEffect(() => {
    const wheelElement = wheelRef.current;
    if (!wheelElement) return;

    let isDragging = false;
    let lastAngle = 0;
    let accumulatedAngle = 0;
    const scrollThreshold = 10;

    const calculateAngle = (e: MouseEvent | TouchEvent) => {
      const rect = wheelElement.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      return Math.atan2(clientY - centerY, clientX - centerX) * (180 / Math.PI);
    };

    const handleInteractionMove = (e: MouseEvent | TouchEvent) => {
      if (!isDragging) return;
      e.preventDefault();

      const currentAngle = calculateAngle(e);
      let delta = currentAngle - lastAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;

      lastAngle = currentAngle;
      accumulatedAngle += delta;

      if (Math.abs(accumulatedAngle) >= scrollThreshold) {
        const direction = Math.sign(accumulatedAngle);
        scrollHandler.current(direction);
        accumulatedAngle -= scrollThreshold * direction;
      }
    };

    const handleInteractionEnd = (e: MouseEvent | TouchEvent) => {
      e.preventDefault();
      isDragging = false;
      document.removeEventListener('mousemove', handleInteractionMove);
      document.removeEventListener('mouseup', handleInteractionEnd);
      document.removeEventListener('touchmove', handleInteractionMove);
      document.removeEventListener('touchend', handleInteractionEnd);
    };

    const handleInteractionStart = (e: MouseEvent | TouchEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      isDragging = true;
      lastAngle = calculateAngle(e);
      accumulatedAngle = 0;
      document.addEventListener('mousemove', handleInteractionMove, { passive: false });
      document.addEventListener('mouseup', handleInteractionEnd, { passive: false });
      document.addEventListener('touchmove', handleInteractionMove, { passive: false });
      document.addEventListener('touchend', handleInteractionEnd, { passive: false });
    };
    
    wheelElement.addEventListener('mousedown', handleInteractionStart);
    wheelElement.addEventListener('touchstart', handleInteractionStart, { passive: false });

    return () => {
      wheelElement.removeEventListener('mousedown', handleInteractionStart);
      wheelElement.removeEventListener('touchstart', handleInteractionStart);
    };
  }, []);

  return (
    <div className="w-full h-1/2 flex items-center justify-center">
      <div
        ref={wheelRef}
        className={`w-56 h-56 ${wheelClass} rounded-full relative shadow-lg border-2 border-black flex items-center justify-center select-none touch-none`}
      >
        <button onClick={onMenuClick} className="absolute top-4 text-gray-100 font-bold text-sm tracking-wider">BACK</button>
        <button onClick={onNextClick} className="absolute right-4 text-gray-100"><NextIcon /></button>
        <button onClick={onPrevClick} className="absolute left-4 text-gray-100"><PrevIcon /></button>
        <button onClick={onPlayPauseClick} className="absolute bottom-4 text-gray-100">{isPlaying ? <PauseIcon /> : <PlayIcon />}</button>
        <button 
            aria-label="Select" 
            onMouseDown={handleSelectMouseDown} 
            onMouseUp={handleSelectMouseUp}
            onTouchStart={handleSelectMouseDown}
            onTouchEnd={handleSelectMouseUp}
            className="w-20 h-20 bg-gray-500 rounded-full flex items-center justify-center shadow-inner"
        ></button>
      </div>
    </div>
  );
});

const StarDisplay = memo<{ rating?: number; active?: boolean }>(({ rating, active }) => {
    if (!rating || rating < 1) return null;
    return (
        <div className="flex items-center space-x-0.5">
            {Array.from({ length: 5 }).map((_, i) => (
                <span key={i} className={`block w-1.5 h-1.5 rounded-full ${i < rating ? (active ? 'bg-white' : 'bg-gray-700') : (active ? 'bg-blue-300' : 'bg-gray-400')}`}></span>
            ))}
        </div>
    );
});

interface MenuViewProps {
  items: MenuItem[];
  activeIndex: number;
}
const MenuView = memo<MenuViewProps>(({ items, activeIndex }) => {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const activeElement = listRef.current?.children[activeIndex] as HTMLLIElement;
    if (activeElement) {
      activeElement.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, [activeIndex]);

  return (
    <ul ref={listRef} className="w-full h-full text-gray-800 font-bold text-base overflow-y-hidden">
      {items.map((item, index) => (
        <li key={`${item.label}-${item.songId ?? index}`} className={`px-2 py-0.5 flex justify-between items-center ${index === activeIndex ? 'bg-blue-500 text-white rounded-sm' : ''}`}>
          <span className="truncate">{item.label}</span>
          <div className="flex items-center shrink-0 space-x-2">
            {item.ratingDisplay}
            {item.subtext && <span className={`text-sm font-normal ${index === activeIndex ? 'text-blue-100' : 'text-gray-600'}`}>{item.subtext}</span>}
            {item.hasArrow && <span className={`font-sans font-bold ${index === activeIndex ? 'text-white' : 'text-gray-500'}`}>{'>'}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
});

const StarRating = memo<{ rating: number; active: boolean }>(({ rating, active }) => (
    <div className={`w-full flex justify-center items-center my-0.5 p-1 rounded ${active ? 'border border-blue-500' : ''}`}>
        {Array.from({ length: 5 }).map((_, i) => (
            <svg key={i} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={`w-6 h-6 ${i < rating ? 'text-blue-500' : 'text-gray-400'}`}>
                <path fillRule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.007z" clipRule="evenodd" />
            </svg>
        ))}
    </div>
));

interface NowPlayingViewProps {
  song: Song;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  mode: NowPlayingMode;
  trackNumber: number;
  totalTracks: number;
}
const NowPlayingView = memo<NowPlayingViewProps>(({ song, currentTime, duration, volume, mode, trackNumber, totalTracks }) => {
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const [artworkUrl, setArtworkUrl] = useState<string | undefined>();

  useEffect(() => {
    if (song.artwork) {
      const blob = new Blob([song.artwork.data], { type: song.artwork.format });
      const url = URL.createObjectURL(blob);
      setArtworkUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setArtworkUrl(undefined);
    }
  }, [song.artwork]);

  return (
    <div className="px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] h-full flex flex-col text-gray-800">
      <div className="flex-grow flex items-start space-x-2 min-h-0">
        <div className="w-2/5 aspect-square bg-gray-300 rounded-sm shadow-md flex-shrink-0">
          {artworkUrl ? (
            <img src={artworkUrl} alt={song.album} className="w-full h-full object-cover rounded-sm" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5z" clipRule="evenodd" />
              </svg>
            </div>
          )}
        </div>
        <div className="w-3/5 flex flex-col space-y-1 overflow-hidden pt-1">
          <p className="font-bold truncate">{song.title}</p>
          <p className="text-sm truncate">{song.artist}</p>
          <p className="text-sm text-gray-600 truncate">{song.album}</p>
        </div>
      </div>
      
      {totalTracks > 0 && (
        <p className="text-center text-xs font-semibold text-gray-600 shrink-0">
          {trackNumber} of {totalTracks}
        </p>
      )}

      <div className="shrink-0 space-y-2 pt-2">
        <div>
          <div className="flex justify-between text-xs font-semibold">
            <span>{formatTime(currentTime)}</span>
            <span>-{formatTime(duration - currentTime)}</span>
          </div>
          <div className="w-full bg-gray-400 rounded-full h-2 my-0.5"><div className="bg-blue-500 h-2 rounded-full" style={{ width: `${progress}%` }}></div></div>
        </div>
        <div className="pt-1">
          <p className="text-center text-xs font-semibold">{mode === 'rating' ? 'Rating' : 'Volume'}</p>
          {mode === 'rating' ? (
              <StarRating rating={song.rating || 0} active={true} />
          ) : (
              <div className="w-full bg-gray-400 rounded-full h-2 my-0.5"><div className="bg-gray-700 h-2 rounded-full" style={{ width: `${volume * 100}%` }}></div></div>
          )}
        </div>
      </div>
    </div>
  );
});

interface FileLoadViewProps {
  isLoading: boolean;
  loadingProgress: string;
  onLoad: () => void;
  isInitialLoad: boolean;
}
const FileLoadView = memo<FileLoadViewProps>(({ isLoading, loadingProgress, onLoad, isInitialLoad }) => (
  <div className="flex flex-col items-center justify-center h-full text-center text-gray-800 p-4">
    {isLoading ? (
      <>
        <div className="w-8 h-8 border-4 border-gray-400 border-t-gray-800 rounded-full animate-spin mb-4"></div>
        <p className="font-bold">Importing Library...</p>
        <p className="text-sm">{loadingProgress}</p>
      </>
    ) : (
      <>
        <h2 className="text-lg font-bold">{isInitialLoad ? 'ReactPod' : 'Add Music'}</h2>
        <p className="mt-2 mb-4">{isInitialLoad ? 'A Classic Music Experience' : 'Add more songs to your library.'}</p>
        <button onClick={onLoad} className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-2 px-4 rounded-lg shadow">
          {isInitialLoad ? 'Load Music' : 'Select Music Folder'}
        </button>
        <p className="text-xs mt-4 text-gray-500">
          {isInitialLoad
            ? 'Select your music folder to build your library. This is a one-time setup.'
            : 'New songs will be added. Duplicates will be ignored.'}
        </p>
      </>
    )}
  </div>
));

interface ClearingLibraryViewProps {
  isClearing: boolean;
  message: string;
}
const ClearingLibraryView = memo<ClearingLibraryViewProps>(({ isClearing, message }) => (
  <div className="flex flex-col items-center justify-center h-full text-center text-gray-800 p-4">
    {isClearing && <div className="w-8 h-8 border-4 border-gray-400 border-t-gray-800 rounded-full animate-spin mb-4"></div>}
    <p className="font-bold">{message}</p>
  </div>
));

interface CoverFlowItem {
    album: string;
    artist: string;
    artwork?: ArtworkData;
}

const CoverFlowItemDisplay = memo<{item: CoverFlowItem; isReflected: boolean}>(({item, isReflected}) => {
    const [artworkUrl, setArtworkUrl] = useState<string | undefined>();
    
    useEffect(() => {
        if (item.artwork) {
            const blob = new Blob([item.artwork.data], { type: item.artwork.format });
            const url = URL.createObjectURL(blob);
            setArtworkUrl(url);
            return () => URL.revokeObjectURL(url);
        } else {
            setArtworkUrl(undefined);
        }
    }, [item.artwork]);
    
    const reflectionClass = isReflected ? '[-webkit-box-reflect:below_1px_linear-gradient(transparent,transparent_80%,rgba(255,255,255,0.4))]' : '';

    return (
        <div className={`w-full h-full bg-gray-300 rounded-sm shadow-md flex items-center justify-center ${reflectionClass}`}>
            {artworkUrl ? (
                <img src={artworkUrl} alt={item.album} className="w-full h-full object-cover rounded-sm" />
            ) : (
                <div className="w-full h-full flex items-center justify-center bg-gray-200 rounded-sm">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5z" clipRule="evenodd" />
                    </svg>
                </div>
            )}
        </div>
    );
});

interface CoverFlowViewProps {
  items: CoverFlowItem[];
  activeIndex: number;
}

const CoverFlowView = memo<CoverFlowViewProps>(({ items, activeIndex }) => {
    if (items.length === 0) {
        return <div className="p-4 text-center font-bold text-gray-600">No Albums Found</div>;
    }

    const activeItem = items[activeIndex];

    return (
        <div className="h-full flex flex-col justify-center items-center overflow-hidden">
            <div className="w-full h-full relative flex items-center justify-center" style={{ perspective: '600px' }}>
                <div
                    className="absolute transition-transform duration-500 ease-out"
                    style={{
                        transformStyle: 'preserve-3d',
                        transform: `translateX(calc(50% - ${activeIndex * 75}px - 50px))`,
                    }}
                >
                    {items.map((item, index) => {
                        const offset = index - activeIndex;
                        const isVisible = Math.abs(offset) < 6;
                        if (!isVisible) return null;

                        const zIndex = items.length - Math.abs(offset);
                        let transform;

                        if (offset === 0) {
                            transform = 'rotateY(0deg) translateZ(50px)';
                        } else if (offset > 0) {
                            transform = `rotateY(-50deg) translateX(30px)`;
                        } else {
                            transform = `rotateY(50deg) translateX(-30px)`;
                        }

                        return (
                            <div
                                key={`${item.album}-${index}`}
                                className="absolute top-1/2 -translate-y-1/2 transition-all duration-500 ease-out"
                                style={{
                                    width: '100px',
                                    height: '100px',
                                    left: `${index * 75}px`,
                                    transform,
                                    zIndex
                                }}
                            >
                                <CoverFlowItemDisplay item={item} isReflected={offset === 0} />
                            </div>
                        );
                    })}
                </div>
            </div>
            <div className="relative shrink-0 w-full text-center pb-2 pt-4 px-2 z-20 bg-gradient-to-t from-white via-white to-transparent">
                <p className="font-bold truncate text-sm text-gray-800">{activeItem?.album ?? ''}</p>
                <p className="text-gray-600 truncate text-xs">{activeItem?.artist ?? ''}</p>
            </div>
        </div>
    );
});

interface SearchViewProps {
  query: string;
  items: MenuItem[];
  activeIndex: number;
}
const SearchView = memo<SearchViewProps>(({ query, items, activeIndex }) => (
  <div className="h-full flex flex-col">
    <div className="shrink-0 px-2 py-0.5 bg-gray-300 border-b border-gray-400">
      <p className="font-bold text-gray-800 truncate h-5 flex items-center">{query || <span className="text-gray-500">Type to search...</span>}</p>
    </div>
    <div className="flex-grow overflow-hidden">
      <MenuView items={items} activeIndex={activeIndex} />
    </div>
  </div>
));

// --- Game Components ---

// --- Bounce Game ---
const PADDLE_ARC_ANGLE = 45; // The paddle covers 45 degrees of the circle

const polarToCartesian = (centerX: number, centerY: number, radius: number, angleInDegrees: number) => {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
};

const describeArc = (x: number, y: number, radius: number, startAngle: number, endAngle: number): string => {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
};

const BounceGameView = (props: BounceGameState & { ballRef: React.RefObject<SVGCircleElement>, paddleRef: React.RefObject<SVGPathElement> }) => {
  const { gameState, score, highScore, paddleAngle, ball, ballRef, paddleRef } = props;
  
  const paddlePath = useMemo(() => {
    const startAngle = paddleAngle - PADDLE_ARC_ANGLE / 2;
    const endAngle = paddleAngle + PADDLE_ARC_ANGLE / 2;
    return describeArc(50, 50, 48, startAngle, endAngle);
  }, [paddleAngle]);

  return (
    <div className="w-full h-full bg-gray-900 relative flex items-center justify-center text-white font-mono overflow-hidden select-none p-2">
      <svg viewBox="0 0 100 100" className="w-full h-full">
        <defs>
            <radialGradient id="arenaGradient">
                <stop offset="80%" stopColor="#1a202c" />
                <stop offset="100%" stopColor="#2d3748" />
            </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="50" fill="url(#arenaGradient)" />
        <circle cx="50" cy="50" r="49.5" stroke="white" strokeWidth="0.5" fill="none" opacity="0.5" />
        
        {gameState === 'playing' && (
          <>
            <path ref={paddleRef} d={paddlePath} stroke="#38bdf8" strokeWidth="3" fill="none" strokeLinecap="round" />
            <circle ref={ballRef} cx={50 + ball.x} cy={50 + ball.y} r="2.5" fill="white" />
          </>
        )}
      </svg>
      <div className="absolute top-2 left-3 font-bold">Score: {score}</div>
      <div className="absolute top-2 right-3 font-bold">Best: {highScore}</div>
      {(gameState === 'paused' || gameState === 'idle') && (
        <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <p className="text-xl font-bold tracking-widest">{gameState === 'paused' ? 'PAUSED' : ''}</p>
        </div>
      )}
    </div>
  );
};

// --- Focus App Components ---
const FocusTimerView = memo<{
    state: FocusState;
    settings: FocusSettings;
    stats: TodayStats;
}>(({ state, settings, stats }) => {
    const totalDuration = 
        (state.sessionType === 'work' ? settings.workMinutes :
        state.sessionType === 'shortBreak' ? settings.shortBreakMinutes :
        state.sessionType === 'longBreak' ? settings.longBreakMinutes : 1) * 60;
    
    const progress = totalDuration > 0 ? ((totalDuration - state.timeRemaining) / totalDuration) * 100 : 0;
    const sessionTitle = state.sessionType.replace(/([A-Z])/g, ' $1');

    return (
        <div className="h-full flex flex-col justify-between items-center text-center p-4 text-gray-800">
            <div>
                <p className="font-bold text-lg capitalize">{sessionTitle}</p>
                <p className="text-5xl font-mono tracking-tighter my-2">
                    {formatTime(state.timeRemaining)}
                </p>
                <div className="w-full bg-gray-400 rounded-full h-2 my-2">
                    <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${progress}%` }}></div>
                </div>
            </div>
            <div className="flex items-center space-x-2">
                {Array.from({ length: settings.longBreakInterval }).map((_, i) => (
                    <span key={i} className={`block w-4 h-4 rounded-full ${i < state.workIntervalsInCycle ? 'bg-blue-500' : 'bg-gray-400'}`}></span>
                ))}
            </div>
            <div>
                <p className="font-semibold">Today's Focus</p>
                <p className="text-sm">Intervals: {stats.workIntervals} | Time: {stats.totalTime}m</p>
            </div>
        </div>
    );
});

const FullscreenBreakView = memo<{ state: FocusState }>(({ state }) => (
    <div className="h-full w-full bg-blue-900 text-white flex flex-col items-center justify-center p-4">
        <p className="text-2xl font-bold mb-4">{state.sessionType === 'shortBreak' ? 'Short Break' : 'Long Break'}</p>
        <p className="text-6xl font-mono tracking-tighter">{formatTime(state.timeRemaining)}</p>
        <p className="mt-4 animate-pulse">Relax...</p>
    </div>
));

const FocusStatsView = memo(() => {
    const [allSessions, setAllSessions] = useState<FocusSession[] | null>(null);
    
    useEffect(() => {
        db.focusSessions.orderBy('endTimestamp').reverse().toArray().then(setAllSessions);
    }, []);

    if (allSessions === null) {
        return <div className="p-4 text-center font-bold text-gray-600">Loading stats...</div>;
    }
    if (allSessions.length === 0) {
        return <div className="p-4 text-center font-bold text-gray-600">No focus sessions completed yet.</div>;
    }

    const today = new Date();
    today.setHours(0,0,0,0);
    const todaySessions = allSessions.filter(s => s.endTimestamp >= today.getTime() && s.type === 'work');
    const todayTime = todaySessions.reduce((sum, s) => sum + s.durationMinutes, 0);

    const thisWeekStart = new Date();
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    thisWeekStart.setHours(0,0,0,0);
    const weekSessions = allSessions.filter(s => s.endTimestamp >= thisWeekStart.getTime() && s.type === 'work');
    const weekTime = weekSessions.reduce((sum, s) => sum + s.durationMinutes, 0);

    const thisMonthStart = new Date();
    thisMonthStart.setDate(1);
    thisMonthStart.setHours(0,0,0,0);
    const monthSessions = allSessions.filter(s => s.endTimestamp >= thisMonthStart.getTime() && s.type === 'work');
    const monthTime = monthSessions.reduce((sum, s) => sum + s.durationMinutes, 0);
    
    return (
        <div className="p-4 text-gray-800 font-semibold space-y-2">
            <h3 className="font-bold text-lg text-center border-b pb-1 mb-2">Focus Stats</h3>
            <div>
                <p>Today</p>
                <p className="text-sm font-normal pl-2">Intervals: {todaySessions.length}</p>
                <p className="text-sm font-normal pl-2">Time: {Math.floor(todayTime / 60)}h {todayTime % 60}m</p>
            </div>
            <div>
                <p>This Week</p>
                <p className="text-sm font-normal pl-2">Intervals: {weekSessions.length}</p>
                <p className="text-sm font-normal pl-2">Time: {Math.floor(weekTime / 60)}h {weekTime % 60}m</p>
            </div>
            <div>
                <p>This Month</p>
                <p className="text-sm font-normal pl-2">Intervals: {monthSessions.length}</p>
                <p className="text-sm font-normal pl-2">Time: {Math.floor(monthTime / 60)}h {monthTime % 60}m</p>
            </div>
        </div>
    );
});


// --- Main App Component ---

const App: React.FC = () => {
    // --- In-Memory State: The primary source of truth for the UI ---
    const [songs, setSongs] = useState<Song[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadingProgress, setLoadingProgress] = useState('');
    
    // --- Navigation & UI State ---
    const [navigationStack, setNavigationStack] = useState([{ id: 'load', activeIndex: 0 }]);
    const [isFlashing, setIsFlashing] = useState(false);
    
    // --- Playback State ---
    const [currentTrackId, setCurrentTrackId] = useState<number | null>(null);
    const [playQueue, setPlayQueue] = useState<number[]>([]);
    const [shuffleMode, setShuffleMode] = useState(false);
    const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
    const [volume, setVolumeState] = useState(0.75);
    const [nowPlayingMode, setNowPlayingMode] = useState<NowPlayingMode>('volume');

    // --- Search State ---
    const [searchQuery, setSearchQuery] = useState('');

    // --- Library Management State ---
    const [clearingState, setClearingState] = useState({
      isClearing: false,
      message: '',
    });
    const [playlistsVersion, setPlaylistsVersion] = useState(0);
    
    // --- Game States ---
    const [bounceGame, setBounceGame] = useState<BounceGameState>(() => ({
      gameState: 'idle',
      score: 0,
      highScore: parseInt(localStorage.getItem('bounceHighScore') || '0', 10),
      paddleAngle: 0,
      ball: { x: 0, y: 0, dx: 0, dy: 0 },
      ballSpeed: 0.8,
    }));
    
    // --- Focus App State ---
    const [focusSettings, setFocusSettings] = useState<FocusSettings | null>(null);
    const [focusState, setFocusState] = useState<FocusState>({
      isActive: false,
      sessionType: 'idle',
      timeRemaining: (focusSettings?.workMinutes ?? 25) * 60,
      workIntervalsInCycle: 0,
    });
    const [todayStats, setTodayStats] = useState<TodayStats>({ workIntervals: 0, totalTime: 0 });

    // --- Appearance State ---
    const [ipodColors, setIpodColors] = useState(() => {
        try {
            const savedColors = localStorage.getItem('ipodColors');
            return savedColors ? JSON.parse(savedColors) : DEFAULT_COLORS;
        } catch (error) {
            console.error('Could not load ipod colors', error);
            return DEFAULT_COLORS;
        }
    });


    // --- Refs ---
    const fileInputRef = useRef<HTMLInputElement>(null);
    const currentObjectUrl = useRef<string | null>(null);
    const gameLoopRef = useRef<number | undefined>();
    const ballRef = useRef<SVGCircleElement>(null);
    const paddleRef = useRef<SVGPathElement>(null);
    const bounceGameStateRef = useRef(bounceGame);
    const audioContextRef = useRef<AudioContext | null>(null);


    useEffect(() => {
        bounceGameStateRef.current = bounceGame;
    }, [bounceGame]);


    // --- Live DB Queries (used for playlists) ---
    const allPlaylists = useLiveQuery(() => db.playlists.orderBy('name').toArray(), [playlistsVersion]);

    // --- Core Playback Logic ---
    const handleNext = useCallback(() => {
        if (playQueue.length === 0 || currentTrackId === null) return;
        
        const currentIndex = playQueue.indexOf(currentTrackId);
        if (currentIndex === -1) return;

        // If we are at the end of the queue
        if (currentIndex === playQueue.length - 1) {
            if (repeatMode === 'all') {
                setCurrentTrackId(playQueue[0]); // Loop to the beginning
            }
            // If repeatMode is 'off' or 'one', playback will stop naturally.
        } else {
            setCurrentTrackId(playQueue[currentIndex + 1]);
        }
    }, [playQueue, currentTrackId, repeatMode]);
    
    const { isPlaying, currentTime, duration, play, pause, resume, setVolume, seek, stop } = usePlayback({ onTrackEnd: handleNext, repeatMode });
    
    const handlePrev = useCallback(() => {
        if (currentTime > 3) {
            seek(0);
            return;
        }
        if (playQueue.length === 0 || currentTrackId === null) return;

        const currentIndex = playQueue.indexOf(currentTrackId);
        if (currentIndex === -1) return;

        // If we are at the beginning of the queue
        if (currentIndex === 0) {
            if (repeatMode === 'all') {
                setCurrentTrackId(playQueue[playQueue.length - 1]); // Loop to the end
            }
            // If repeatMode is 'off' or 'one', do nothing.
        } else {
            setCurrentTrackId(playQueue[currentIndex - 1]);
        }
    }, [playQueue, currentTrackId, currentTime, repeatMode, seek]);
    
    const currentSong = useMemo(() => songs.find(s => s.id === currentTrackId), [songs, currentTrackId]);
    const currentView = navigationStack[navigationStack.length - 1];
    
    // --- Media Session Integration ---
    const handleMediaSessionPlay = useCallback(() => {
        // This is the "play" part of the handlePlayPause toggle.
        if (currentTrackId) {
            resume();
        } else if (playQueue.length > 0) {
            setCurrentTrackId(playQueue[0]);
        }
    }, [currentTrackId, playQueue, resume]);

    useMediaSession({
        song: currentSong,
        isPlaying,
        onPlay: handleMediaSessionPlay,
        onPause: pause,
        onNext: handleNext,
        onPrev: handlePrev,
    });

    // Set audio element volume when our state changes
    useEffect(() => {
        setVolume(volume);
    }, [volume, setVolume]);

    // Effect to play a new track when currentTrackId changes
    useEffect(() => {
        if (currentObjectUrl.current) {
            URL.revokeObjectURL(currentObjectUrl.current);
            currentObjectUrl.current = null;
        }
        if (currentTrackId !== null) {
            db.songs.get(currentTrackId).then(song => {
                if (song?.fileBlob) {
                    const url = URL.createObjectURL(song.fileBlob);
                    currentObjectUrl.current = url;
                    play(url);
                } else if (song === undefined) {
                    console.warn(`Song with id ${currentTrackId} not found. Skipping.`);
                    handleNext();
                }
            }).catch(error => {
                console.error(`Error loading song with id ${currentTrackId}:`, error);
                handleNext();
            });
        } else {
            stop();
        }
    }, [currentTrackId, play, stop, handleNext]);

    // --- Focus App Logic ---
    const playBeep = useCallback((freq = 523.25, duration = 150, vol = 20) => {
        try {
            if (!audioContextRef.current) {
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            }
            const audioCtx = audioContextRef.current;
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            const oscillator = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            oscillator.connect(gain);
            oscillator.frequency.value = freq;
            oscillator.type = "sine";
            gain.connect(audioCtx.destination);
            gain.gain.value = vol * 0.01;
            oscillator.start(audioCtx.currentTime);
            oscillator.stop(audioCtx.currentTime + duration * 0.001);
        } catch (e) {
            console.warn("Could not play sound", e);
        }
    }, []);

    const calculateTodayStats = useCallback(async () => {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const completedToday = await db.focusSessions
          .where('endTimestamp').above(startOfToday.getTime())
          .filter(s => s.type === 'work')
          .toArray();

        const totalTime = completedToday.reduce((sum, s) => sum + s.durationMinutes, 0);
        setTodayStats({ workIntervals: completedToday.length, totalTime });
    }, []);

    const handleSessionEnd = useCallback(async () => {
        if (!focusSettings) return;
        
        playBeep(880, 500);

        const completedSessionType = focusState.sessionType;
        if (completedSessionType !== 'idle') {
            const completedDuration =
            completedSessionType === 'work' ? focusSettings.workMinutes :
            completedSessionType === 'shortBreak' ? focusSettings.shortBreakMinutes :
            focusSettings.longBreakMinutes;

            await db.focusSessions.add({
                endTimestamp: Date.now(),
                durationMinutes: completedDuration,
                type: completedSessionType,
            });

            if (completedSessionType === 'work') {
                await calculateTodayStats();
            }
        }
        
        let nextSessionType: FocusState['sessionType'] = 'work';
        let nextWorkIntervals = focusState.workIntervalsInCycle;

        if (completedSessionType === 'work') {
            nextWorkIntervals++;
            if (nextWorkIntervals >= focusSettings.longBreakInterval) {
                nextSessionType = 'longBreak';
                nextWorkIntervals = 0;
            } else {
                nextSessionType = 'shortBreak';
            }
        } else {
            nextSessionType = 'work';
        }

        const nextDuration = 
            (nextSessionType === 'work' ? focusSettings.workMinutes :
            nextSessionType === 'shortBreak' ? focusSettings.shortBreakMinutes :
            focusSettings.longBreakMinutes) * 60;
        
        setFocusState({
            isActive: focusSettings.autoStart,
            sessionType: nextSessionType,
            timeRemaining: nextDuration,
            workIntervalsInCycle: nextWorkIntervals,
        });
        
        if (focusSettings.autoStart) {
            playBeep(440, 200);
        }
    }, [focusState, focusSettings, playBeep, calculateTodayStats]);

    useEffect(() => {
        if (!focusState.isActive || focusState.sessionType === 'idle') {
            return;
        }

        const interval = setInterval(() => {
            setFocusState(s => {
                if (s.timeRemaining <= 1) {
                    clearInterval(interval);
                    handleSessionEnd();
                    return { ...s, isActive: false, timeRemaining: 0 };
                }
                return { ...s, timeRemaining: s.timeRemaining - 1 };
            });
        }, 1000);

        return () => clearInterval(interval);
    }, [focusState.isActive, focusState.sessionType, handleSessionEnd]);


    // --- App Initialization ---
    useEffect(() => {
        const initializeApp = async () => {
            setIsLoading(true);
            try {
                await db.open();
                await db.transaction('rw', db.playlists, db.focusSettings, async () => {
                    const otgPlaylist = await db.playlists.get({ name: 'On-The-Go' });
                    if (!otgPlaylist) {
                        await db.playlists.add({ name: 'On-The-Go', songIds: [] });
                    }
                    const settings = await db.focusSettings.get(0);
                    if (!settings) {
                        await db.focusSettings.put(DEFAULT_FOCUS_SETTINGS);
                    }
                }).catch(e => {
                    console.warn("Initialization transaction failed, likely because items already exist.", e);
                });
                
                const settings = await db.focusSettings.get(0) || DEFAULT_FOCUS_SETTINGS;
                setFocusSettings(settings);
                setFocusState(s => ({ ...s, timeRemaining: settings.workMinutes * 60, sessionType: 'work' }));
                await calculateTodayStats();

                const songCount = await db.songs.count();
                if (songCount > 0) {
                    const loadedSongs = await db.songs.toArray();
                    setSongs(loadedSongs);
                    setNavigationStack([{ id: 'main', activeIndex: 0 }]);
                } else {
                    setNavigationStack([{ id: 'load', activeIndex: 0 }]);
                }
            } catch (error) {
                console.error("Failed to initialize the application database:", error);
            } finally {
                setIsLoading(false);
            }
        };

        initializeApp();
    }, [calculateTodayStats]);

    // --- Data Management Functions ---

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      
      setIsLoading(true);
      setLoadingProgress('Parsing files...');
      
      const parsedSongs: (Omit<Song, 'id'> & { folderName?: string })[] = [];
      const totalFiles = files.length;
      for (let i = 0; i < totalFiles; i++) {
          const file = files[i];
          const fileNameLower = file.name.toLowerCase();
          if (SUPPORTED_EXTENSIONS.some(ext => fileNameLower.endsWith(ext))) {
              try {
                  const metadata = await mmb.parseBlob(file);
                  const { common, format } = metadata;
                  const artwork = common.picture?.[0] ? { data: common.picture[0].data, format: common.picture[0].format } : undefined;
                  const pathParts = (file as any).webkitRelativePath.split('/');
                  const folderName = pathParts.length > 1 ? pathParts[pathParts.length - 2] : undefined;

                  parsedSongs.push({
                      fileBlob: file,
                      title: common.title || file.name.replace(/\.[^/.]+$/, ""),
                      artist: common.artist || 'Unknown Artist',
                      album: common.album || 'Unknown Album',
                      duration: format.duration || 0,
                      artwork: artwork,
                      folderName,
                  });
              } catch (e) { console.error(`Skipping file ${file.name}:`, e); }
          }
          if (i % 20 === 0) {
            setLoadingProgress(`Processing ${i + 1} of ${totalFiles}...`);
            await new Promise(resolve => setTimeout(resolve, 0));
          }
      }

      setLoadingProgress('Checking for duplicates...');
      await new Promise(resolve => setTimeout(resolve, 0));

      try {
          const existingSongs = await db.songs.toArray();
          const existingSongKeys = new Set(
              existingSongs.map(s => `${s.title.trim().toLowerCase()}|${s.artist.trim().toLowerCase()}|${s.album.trim().toLowerCase()}`)
          );

          const songsToAdd = parsedSongs.filter(s => {
              const key = `${s.title.trim().toLowerCase()}|${s.artist.trim().toLowerCase()}|${s.album.trim().toLowerCase()}`;
              return !existingSongKeys.has(key);
          });
          
          if (songsToAdd.length > 0) {
              setLoadingProgress(`Adding ${songsToAdd.length} new songs...`);
              const songsForDb = songsToAdd.map(({ folderName, ...rest }) => rest);
              const addedSongIds = await db.songs.bulkAdd(songsForDb as Song[], { allKeys: true }) as number[];

              const folderToSongIds = new Map<string, number[]>();
              songsToAdd.forEach((song, index) => {
                  if (song.folderName) {
                      if (!folderToSongIds.has(song.folderName)) {
                          folderToSongIds.set(song.folderName, []);
                      }
                      folderToSongIds.get(song.folderName)!.push(addedSongIds[index]);
                  }
              });
              
              if (folderToSongIds.size > 0) {
                  setLoadingProgress('Creating playlists...');
                  await db.transaction('rw', db.playlists, async () => {
                      for (const [folderName, newSongIds] of folderToSongIds.entries()) {
                          const existingPlaylist = await db.playlists.get({ name: folderName });
                          if (existingPlaylist) {
                              const combinedSongIds = [...new Set([...existingPlaylist.songIds, ...newSongIds])];
                              await db.playlists.update(existingPlaylist.id!, { songIds: combinedSongIds });
                          } else {
                              await db.playlists.add({ name: folderName, songIds: newSongIds });
                          }
                      }
                  });
                  setPlaylistsVersion(v => v + 1);
              }
          } else {
              setLoadingProgress('No new songs to add.');
              await new Promise(resolve => setTimeout(resolve, 1500)); // Show message briefly
          }
          
          const allSongs = await db.songs.toArray();
          setSongs(allSongs);
          
          await db.transaction('rw', db.playlists, async () => {
            const otg = await db.playlists.get({name: 'On-The-Go'});
            if (!otg) await db.playlists.add({name: 'On-The-Go', songIds: []});
          }).catch(e => {
              console.warn("Could not create On-The-Go playlist after file change, it likely already exists.", e);
          });
          
          setNavigationStack([{ id: 'main', activeIndex: 0 }]);
      } catch (error) { 
          console.error("Failed to save songs:", error); 
          alert("An error occurred while adding music. Please try again.");
      } finally {
          setIsLoading(false);
          setLoadingProgress('');
      }
    };
    
    const handleSetRating = useCallback(async (songId: number, rating: number) => {
        const newRating = Math.max(0, Math.min(5, Math.round(rating)));
        try {
            await db.songs.update(songId, { rating: newRating });
            setSongs(prevSongs => prevSongs.map(s => s.id === songId ? { ...s, rating: newRating } : s));
        } catch (error) {
            console.error(`Failed to update rating for song ${songId}:`, error);
        }
    }, []);

    const updateFocusSetting = useCallback(async (key: keyof FocusSettings, value: any) => {
        if (!focusSettings) return;
        const newSettings = { ...focusSettings, [key]: value };
        await db.focusSettings.put(newSettings);
        setFocusSettings(newSettings);
    }, [focusSettings]);

    const handleSetColor = useCallback((type: 'body' | 'wheel', colorClass: string) => {
        setIpodColors(prev => {
            const newColors = { ...prev, [type]: colorClass };
            localStorage.setItem('ipodColors', JSON.stringify(newColors));
            return newColors;
        });
    }, []);

    const resetColors = useCallback(() => {
        setIpodColors(DEFAULT_COLORS);
        localStorage.removeItem('ipodColors');
    }, []);

    // --- Stable Interaction Handlers ---
    
    const handleMenuClick = useCallback(() => {
        if (currentView.id.startsWith('focus-setting-edit/')) {
            const key = currentView.id.split('/')[1] as keyof FocusSettings;
            const value = currentView.activeIndex;
            updateFocusSetting(key, value);
        }

        const latestView = navigationStack[navigationStack.length - 1];
        if (latestView.id === 'bounce-game') {
            setBounceGame(g => ({
                ...g,
                gameState: 'idle',
                score: 0,
                ball: getInitialBallVelocity(0.5),
                ballSpeed: 0.8,
            }));
        }

        setNowPlayingMode('volume'); // Reset mode on exit
        if (navigationStack.length > 1) {
            setNavigationStack(s => s.slice(0, -1));
        }
    }, [navigationStack, updateFocusSetting, currentView]);
    
    const handleClearLibrary = useCallback(async () => {
        setNavigationStack(s => [...s, { id: 'clearing-library', activeIndex: 0 }]);
        setClearingState({ isClearing: true, message: 'Calculating...' });

        try {
            const allSongKeys = await db.songs.toCollection().keys() as number[];
            const totalCount = allSongKeys.length;

            if (totalCount === 0) {
                setClearingState({ isClearing: false, message: 'Library is already empty.' });
                setTimeout(() => {
                    setNavigationStack(s => s.slice(0, -1)); // Go back
                }, 2000);
                return;
            }

            let deletedCount = 0;
            const chunkSize = 50;
            for (let i = 0; i < totalCount; i += chunkSize) {
                const chunk = allSongKeys.slice(i, i + chunkSize);
                await db.songs.bulkDelete(chunk);
                deletedCount += chunk.length;
                setClearingState({ isClearing: true, message: `Deleting... ${deletedCount} songs removed` });
                await new Promise(resolve => setTimeout(resolve, 50)); // Allow UI to update
            }

            // Clear On-The-Go playlist
            const otg = await db.playlists.get({ name: 'On-The-Go' });
            if (otg && otg.id) {
                await db.playlists.update(otg.id, { songIds: [] });
            }

            // Final state
            setClearingState({ isClearing: false, message: `Library cleared. ${totalCount} items removed.` });
            
            // Reset app state
            stop();
            setSongs([]);
            setPlayQueue([]);
            setCurrentTrackId(null);
            
            setTimeout(() => {
                setNavigationStack([{ id: 'load', activeIndex: 0 }]);
                setClearingState({ isClearing: false, message: '' });
            }, 2500);

        } catch (error) {
            console.error("Failed to clear library:", error);
            setClearingState({ isClearing: false, message: 'An error occurred.' });
            setTimeout(() => {
                 setNavigationStack(s => s.slice(0, -1)); // Go back
            }, 2000);
        }
    }, [stop]);

    const handleFocusPlayPause = useCallback(() => {
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume();
        }
        if (!focusState.isActive) {
            if (isPlaying) pause(); // Stop music if starting focus session
            playBeep(440, 200);
        } else {
            playBeep(330, 200);
        }
        setFocusState(s => ({ ...s, isActive: !s.isActive }));
    }, [focusState.isActive, isPlaying, pause, playBeep]);
    
    // --- Memoized Derived Data for Menus and Views ---
    const menuItems: MenuItem[] = useMemo(() => {
        const createPlayAction = (songId: number, queue: number[]) => () => {
            let finalQueue = [...queue];
            if (shuffleMode) {
                const shuffled = finalQueue.filter(id => id !== songId);
                for (let i = shuffled.length - 1; i > 0; i--) {
                  const j = Math.floor(Math.random() * (i + 1));
                  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                }
                finalQueue = [songId, ...shuffled];
            }
            setPlayQueue(finalQueue);
            setCurrentTrackId(songId);
        };

        const viewId = currentView.id;
        const viewParam = viewId.includes('/') ? viewId.split('/')[1] : undefined;

        switch (true) {
            case viewId === 'main': return [
                    { label: 'Now Playing', action: () => { if (currentTrackId !== null) setNavigationStack(s => [...s, { id: 'now-playing', activeIndex: 0 }])}, hasArrow: currentTrackId !== null },
                    { label: 'Music', action: () => setNavigationStack(s => [...s, { id: 'music', activeIndex: 0 }]), hasArrow: true },
                    { label: 'Playlists', action: () => setNavigationStack(s => [...s, { id: 'playlists', activeIndex: 0 }]), hasArrow: true },
                    { label: 'Focus', action: () => {
                        if (isPlaying) pause();
                        setNavigationStack(s => [...s, { id: 'focus', activeIndex: 0 }]);
                    }, hasArrow: true },
                    { label: 'Bounce', action: () => {
                        stop();
                        setBounceGame((g) => ({
                            ...g,
                            gameState: 'idle',
                            score: 0,
                            ball: getInitialBallVelocity(0.5),
                            ballSpeed: 0.8,
                        }));
                        setNavigationStack(s => [...s, { id: 'bounce-game', activeIndex: 0 }]);
                    }, hasArrow: true },
                    { label: 'Settings', action: () => setNavigationStack(s => [...s, { id: 'settings', activeIndex: 0 }]), hasArrow: true },
            ];
            case viewId === 'focus': return [
                    { label: focusState.isActive ? 'Pause' : 'Start', action: handleFocusPlayPause },
                    { label: 'Skip Session', action: () => handleSessionEnd() },
                    { label: 'Stats', action: () => setNavigationStack(s => [...s, { id: 'focus-stats', activeIndex: 0 }]), hasArrow: true },
                    { label: 'Settings', action: () => setNavigationStack(s => [...s, { id: 'focus-settings', activeIndex: 0 }]), hasArrow: true },
            ];
            case viewId === 'focus-settings': return [
                    { label: 'Work Duration', subtext: `${focusSettings?.workMinutes} min`, action: () => setNavigationStack(s => [...s, { id: `focus-setting-edit/workMinutes`, activeIndex: focusSettings?.workMinutes ?? 25 }]), hasArrow: true },
                    { label: 'Short Break', subtext: `${focusSettings?.shortBreakMinutes} min`, action: () => setNavigationStack(s => [...s, { id: `focus-setting-edit/shortBreakMinutes`, activeIndex: focusSettings?.shortBreakMinutes ?? 5 }]), hasArrow: true },
                    { label: 'Long Break', subtext: `${focusSettings?.longBreakMinutes} min`, action: () => setNavigationStack(s => [...s, { id: `focus-setting-edit/longBreakMinutes`, activeIndex: focusSettings?.longBreakMinutes ?? 15 }]), hasArrow: true },
                    { label: 'Intervals', subtext: `${focusSettings?.longBreakInterval}`, action: () => setNavigationStack(s => [...s, { id: `focus-setting-edit/longBreakInterval`, activeIndex: focusSettings?.longBreakInterval ?? 4 }]), hasArrow: true },
                    { label: `Auto Start: ${focusSettings?.autoStart ? 'On' : 'Off'}`, action: () => updateFocusSetting('autoStart', !focusSettings?.autoStart) },
                    { label: `Fullscreen Break: ${focusSettings?.fullscreenBreak ? 'On' : 'Off'}`, action: () => updateFocusSetting('fullscreenBreak', !focusSettings?.fullscreenBreak) },
                    { label: 'Reset Stats', action: () => setNavigationStack(s => [...s, { id: 'focus-reset-confirm', activeIndex: 0 }]), hasArrow: true },
            ];
            case viewId === 'focus-reset-confirm': return [
                { label: 'No, Cancel', action: handleMenuClick },
                { label: 'Yes, Reset All Stats', action: async () => {
                    await db.focusSessions.clear();
                    await calculateTodayStats();
                    setNavigationStack(s => s.slice(0, -2));
                } },
            ];
            case viewId === 'bounce-game': {
                 if (bounceGame.gameState === 'idle') {
                    return [{ label: 'Start Game', action: () => setBounceGame(g => ({
                        ...g,
                        gameState: 'playing',
                        score: 0,
                        ballSpeed: 0.8,
                        ball: getInitialBallVelocity(0.5),
                    })) }];
                }
                if (bounceGame.gameState === 'game-over') {
                    return [
                        { label: 'Play Again', action: () => {
                            setBounceGame(g => ({
                                ...g,
                                gameState: 'playing',
                                score: 0,
                                ball: getInitialBallVelocity(0.5),
                                ballSpeed: 0.8,
                            }));
                        }},
                        { label: 'Exit', action: handleMenuClick }
                    ];
                }
                return [];
            }
            case viewId === 'music': return [
                    { label: 'Cover Flow', action: () => setNavigationStack(s => [...s, { id: 'cover-flow', activeIndex: 0 }]), hasArrow: true },
                    { label: 'Songs', action: () => setNavigationStack(s => [...s, { id: 'songs', activeIndex: 0 }]), hasArrow: true },
                    { label: 'Artists', action: () => setNavigationStack(s => [...s, { id: 'artists', activeIndex: 0 }]), hasArrow: true },
                    { label: 'Albums', action: () => setNavigationStack(s => [...s, { id: 'albums', activeIndex: 0 }]), hasArrow: true },
                    { label: 'Ratings', action: () => setNavigationStack(s => [...s, { id: 'ratings', activeIndex: 0 }]), hasArrow: true },
                    { label: 'Search', action: () => { setSearchQuery(''); setNavigationStack(s => [...s, { id: 'search', activeIndex: 0 }])}, hasArrow: true },
            ];
            case viewId === 'playlists': {
                if (!allPlaylists) return [];
                const otgPlaylist = allPlaylists.find(p => p.name === 'On-The-Go');
                const otherPlaylists = allPlaylists.filter(p => p.name !== 'On-The-Go');

                const menu: MenuItem[] = [];
                if (otgPlaylist) {
                    menu.push({ 
                        label: 'On-The-Go', 
                        action: () => setNavigationStack(s => [...s, { id: `playlist-songs/${otgPlaylist.id}`, activeIndex: 0 }]), 
                        hasArrow: true, 
                        subtext: `${otgPlaylist.songIds.length}`
                    });
                }
                
                otherPlaylists.forEach(playlist => {
                    menu.push({
                        label: playlist.name,
                        action: () => setNavigationStack(s => [...s, { id: `playlist-songs/${playlist.id}`, activeIndex: 0 }]),
                        hasArrow: true,
                        subtext: `${playlist.songIds.length}`
                    });
                });

                return menu;
            }
            case viewId.startsWith('playlist-songs/'): {
                if (!allPlaylists) return [];
                const playlistId = parseInt(viewParam!, 10);
                const playlist = allPlaylists.find(p => p.id === playlistId);
                if (!playlist) return [];
                
                const playlistSongs = (playlist.songIds ?? []).map(id => songs.find(s => s.id === id)).filter((s): s is Song => !!s);
                
                return playlistSongs.map(song => ({
                    label: song.title,
                    action: createPlayAction(song.id!, playlistSongs.map(s => s.id!)),
                    ratingDisplay: <StarDisplay rating={song.rating} active={false} />,
                    songId: song.id!,
                }));
            }
            case viewId === 'songs':
                return songs.sort((a,b) => a.title.localeCompare(b.title)).map(song => ({
                    label: song.title,
                    action: createPlayAction(song.id!, songs.map(s => s.id!)),
                    ratingDisplay: <StarDisplay rating={song.rating} active={false} />,
                    songId: song.id!,
                }));
            case viewId === 'search-results':
                const q = searchQuery.toLowerCase().trim();
                const searchResults = q === '' ? [] : songs.filter(s => s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q) || s.album.toLowerCase().includes(q));
                 return searchResults.map(song => ({
                    label: song.title,
                    action: createPlayAction(song.id!, searchResults.map(s => s.id!)),
                    ratingDisplay: <StarDisplay rating={song.rating} active={false} />,
                    songId: song.id!,
                }));
            case viewId.startsWith('rated-songs/'): {
                const minRating = parseInt(viewParam!, 10);
                const ratedSongs = songs.filter(s => (s.rating ?? 0) >= minRating);
                return ratedSongs.map(song => ({
                    label: song.title,
                    action: createPlayAction(song.id!, ratedSongs.map(s => s.id!)),
                    ratingDisplay: <StarDisplay rating={song.rating} active={false} />,
                    songId: song.id!,
                }));
            }
            case viewId.startsWith('album-songs/'): {
                const albumSongs = songs.filter(s => s.album === viewParam);
                return albumSongs.map(song => ({
                    label: song.title,
                    action: createPlayAction(song.id!, albumSongs.map(s => s.id!)),
                    ratingDisplay: <StarDisplay rating={song.rating} active={false} />,
                    songId: song.id!,
                }));
            }
            case viewId === 'artists':
                 const uniqueArtists = [...new Set(songs.map(s => s.artist))].sort();
                 return uniqueArtists.map(artist => ({ label: artist, action: () => setNavigationStack(s => [...s, { id: `artist-albums/${artist}`, activeIndex: 0 }]), hasArrow: true }));
            case viewId.startsWith('artist-albums/'):
                const artistSongs = songs.filter(s => s.artist === viewParam);
                const artistAlbums = [...new Set(artistSongs.map(s => s.album))].sort();
                return artistAlbums.map(album => ({ label: album, action: () => setNavigationStack(s => [...s, { id: `album-songs/${album}`, activeIndex: 0 }]), hasArrow: true, }));
            case viewId === 'albums':
                const uniqueAlbums = [...new Set(songs.map(s => s.album))].sort();
                return uniqueAlbums.map(album => ({ label: album, action: () => setNavigationStack(s => [...s, { id: `album-songs/${album}`, activeIndex: 0 }]), hasArrow: true }));
            case viewId === 'ratings': return [5, 4, 3, 2, 1].map(r => ({ label: '★'.repeat(r) + '☆'.repeat(5 - r), action: () => setNavigationStack(s => [...s, { id: `rated-songs/${r}`, activeIndex: 0 }]), hasArrow: true }));
            case viewId === 'settings': return [
                  { label: `Shuffle: ${shuffleMode ? 'On' : 'Off'}`, action: () => setShuffleMode(s => !s) },
                  { label: `Repeat: ${repeatMode.charAt(0).toUpperCase() + repeatMode.slice(1)}`, action: () => setRepeatMode(r => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off')) },
                  { label: 'Appearance', action: () => setNavigationStack(s => [...s, { id: 'appearance', activeIndex: 0 }]), hasArrow: true },
                  { label: 'Library Management', action: () => setNavigationStack(s => [...s, { id: 'library-management', activeIndex: 0 }]), hasArrow: true },
                  { label: 'About', action: () => setNavigationStack(s => [...s, { id: 'about', activeIndex: 0 }]), hasArrow: true },
            ];
            case viewId === 'library-management': return [
                { label: 'Add Music', action: () => setNavigationStack(s => [...s, { id: 'load', activeIndex: 0 }]) , hasArrow: true },
                { label: 'Clear Library', action: handleClearLibrary, hasArrow: true },
            ];
            case viewId === 'appearance': return [
                { label: 'iPod Body', action: () => setNavigationStack(s => [...s, { id: 'body-color', activeIndex: 0 }]), hasArrow: true },
                { label: 'Click Wheel', action: () => setNavigationStack(s => [...s, { id: 'wheel-color', activeIndex: 0 }]), hasArrow: true },
                { label: 'Reset to Default', action: resetColors },
            ];
            case viewId === 'body-color':
                return BODY_COLORS.map(color => ({
                    label: color.name,
                    action: () => handleSetColor('body', color.class),
                    hasArrow: ipodColors.body === color.class ? false : undefined,
                    subtext: ipodColors.body === color.class ? '✓' : ''
                }));
            case viewId === 'wheel-color':
                return WHEEL_COLORS.map(color => ({
                    label: color.name,
                    action: () => handleSetColor('wheel', color.class),
                    hasArrow: ipodColors.wheel === color.class ? false : undefined,
                    subtext: ipodColors.wheel === color.class ? '✓' : ''
                }));
            case viewId === 'search':
                const SEARCH_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
                return [
                    ...SEARCH_CHARS.map(char => ({ label: char, action: () => setSearchQuery(q => q + char) })),
                    { label: 'Space', action: () => setSearchQuery(q => q + ' ') },
                    { label: 'Delete', action: () => setSearchQuery(q => q.slice(0, -1)) },
                    { label: 'Done', action: () => setNavigationStack(s => [...s, { id: 'search-results', activeIndex: 0 }]), hasArrow: true }
                ];
            default: return [];
        }
    }, [
        songs, currentView, shuffleMode, repeatMode, currentTrackId, allPlaylists, searchQuery, bounceGame, handleMenuClick, stop, ipodColors, resetColors, handleSetColor, handleClearLibrary, focusState, focusSettings, handleFocusPlayPause, handleSessionEnd, updateFocusSetting, calculateTodayStats, isPlaying, pause,
    ]);
    
    const coverFlowItems: CoverFlowItem[] = useMemo(() => {
        if (songs.length === 0) return [];
        const albumMap = new Map<string, { artist: string; artwork?: ArtworkData }>();
        songs.forEach(song => {
            if (!albumMap.has(song.album)) {
                albumMap.set(song.album, { artist: song.artist, artwork: song.artwork });
            } else {
                const existing = albumMap.get(song.album)!;
                if (!existing.artwork && song.artwork) {
                    existing.artwork = song.artwork;
                }
            }
        });
        return Array.from(albumMap.entries())
            .map(([album, { artist, artwork }]) => ({ album, artist, artwork }))
            .sort((a, b) => a.album.localeCompare(b.album));
    }, [songs]);
    
    // --- Game Logic ---
    useEffect(() => {
      // --- Main Game Loop ---
      const gameLoop = () => {
          const currentGameState = bounceGameStateRef.current;
          // Only run logic if in the game and playing
          if (currentView.id === 'bounce-game' && currentGameState.gameState === 'playing') {
              
              const ARENA_RADIUS = 47.5; // 50 (arena) - 2.5 (ball radius)
              const { ball, paddleAngle, score, ballSpeed, highScore } = currentGameState;

              let newBall = { ...ball };
              newBall.x += newBall.dx * ballSpeed;
              newBall.y += newBall.dy * ballSpeed;

              const distFromCenter = Math.sqrt(newBall.x * newBall.x + newBall.y * newBall.y);
              
              let stateUpdateForReact: Partial<BounceGameState> = {};

              if (distFromCenter > ARENA_RADIUS) {
                  const physicsAngle = Math.atan2(newBall.y, newBall.x) * (180 / Math.PI);
                  const ballAngleDegrees = (physicsAngle + 90 + 360) % 360;

                  const paddleStart = (paddleAngle - PADDLE_ARC_ANGLE / 2 + 360) % 360;
                  const paddleEnd = (paddleAngle + PADDLE_ARC_ANGLE / 2 + 360) % 360;
                  
                  const isHit = paddleStart < paddleEnd
                    ? ballAngleDegrees >= paddleStart && ballAngleDegrees <= paddleEnd
                    : ballAngleDegrees >= paddleStart || ballAngleDegrees <= paddleEnd;

                  if (isHit) {
                      const newScore = score + 1;
                      const newBallSpeed = Math.min(2.5, ballSpeed * 1.03);
                      stateUpdateForReact = { score: newScore, ballSpeed: newBallSpeed };
                      
                      let relativeHitAngle = ballAngleDegrees - paddleAngle;
                      if (relativeHitAngle > 180) relativeHitAngle -= 360;
                      if (relativeHitAngle < -180) relativeHitAngle += 360;
                      
                      const deflectionFactor = relativeHitAngle / (PADDLE_ARC_ANGLE / 2);
                      const impactNormalRad = Math.atan2(-newBall.y, -newBall.x);
                      const maxDeflectionRad = Math.PI / 3.5;
                      const deflectionRad = deflectionFactor * maxDeflectionRad;
                      const finalAngleRad = impactNormalRad + deflectionRad;

                      newBall.dx = Math.cos(finalAngleRad);
                      newBall.dy = Math.sin(finalAngleRad);
                      
                      const normalAngleRad = Math.atan2(newBall.y, newBall.x);
                      newBall.x = (ARENA_RADIUS - 0.1) * Math.cos(normalAngleRad);
                      newBall.y = (ARENA_RADIUS - 0.1) * Math.sin(normalAngleRad);
                  } else {
                      let newHighScore = highScore;
                      if (score > highScore) {
                          newHighScore = score;
                          localStorage.setItem('bounceHighScore', newHighScore.toString());
                      }
                      stateUpdateForReact = { gameState: 'game-over', highScore: newHighScore };
                  }
              }

              // Update the ref for the next frame's calculation
              bounceGameStateRef.current = {
                  ...currentGameState,
                  ...stateUpdateForReact,
                  ball: newBall,
              };

              // Directly update ball position
              if (ballRef.current) {
                  ballRef.current.setAttribute('cx', `${50 + newBall.x}`);
                  ballRef.current.setAttribute('cy', `${50 + newBall.y}`);
              }
              
              // Only call setState for infrequent updates to sync state and trigger re-render
              if (Object.keys(stateUpdateForReact).length > 0) {
                  // Sync the React state with the latest game state from the ref.
                  // This prevents visual jumps on re-renders caused by score/gameState changes,
                  // as the ball and paddle positions in the React state would otherwise be stale.
                  setBounceGame(bounceGameStateRef.current);
              }
          }
          gameLoopRef.current = requestAnimationFrame(gameLoop);
      };

      gameLoopRef.current = requestAnimationFrame(gameLoop);

      return () => {
        if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
      }
    }, [currentView.id]);

    const handlePlayPause = useCallback(() => {
        if (currentView.id.startsWith('focus')) {
            handleFocusPlayPause();
            return;
        }

        if (currentView.id === 'bounce-game') {
            if (bounceGame.gameState === 'playing') setBounceGame(g => ({ ...g, gameState: 'paused' }));
            else if (bounceGame.gameState === 'paused') setBounceGame(g => ({ ...g, gameState: 'playing' }));
            return;
        }

        if (isPlaying) pause();
        else if (currentTrackId) resume();
        else if (playQueue.length > 0) setCurrentTrackId(playQueue[0]);
        
    }, [isPlaying, currentTrackId, playQueue, pause, resume, currentView.id, bounceGame.gameState, handleFocusPlayPause]);

    const handleScroll = useCallback((direction: number) => {
        if (currentView.id.startsWith('focus-setting-edit/')) {
            const key = currentView.id.split('/')[1] as keyof FocusSettings;
            setNavigationStack(stack => {
                const last = stack[stack.length - 1];
                let newValue = last.activeIndex + direction;
                if (key === 'longBreakInterval') {
                    newValue = Math.max(1, Math.min(10, newValue));
                } else {
                    newValue = Math.max(1, Math.min(90, newValue)); // minutes
                }
                return [...stack.slice(0, -1), { ...last, activeIndex: newValue }];
            });
            return;
        }

        if (currentView.id === 'bounce-game' && bounceGameStateRef.current.gameState === 'playing') {
            const newAngle = (bounceGameStateRef.current.paddleAngle + direction * 10 + 360) % 360;
            bounceGameStateRef.current.paddleAngle = newAngle;

            if (paddleRef.current) {
                const newPaddlePath = describeArc(50, 50, 48, newAngle - PADDLE_ARC_ANGLE / 2, newAngle + PADDLE_ARC_ANGLE / 2);
                paddleRef.current.setAttribute('d', newPaddlePath);
            }
            return;
        }

        if (currentView.id === 'now-playing' && currentSong?.id) {
            if (nowPlayingMode === 'rating') {
                const currentRating = currentSong.rating || 0;
                const newRating = Math.max(0, Math.min(5, currentRating + direction));
                if (newRating !== currentRating) handleSetRating(currentSong.id, newRating);
            } else {
                setVolumeState(v => Math.max(0, Math.min(1, v + direction * 0.05)));
            }
            return;
        }

        const items = currentView.id === 'cover-flow' ? coverFlowItems : menuItems;
        if (!items || items.length === 0) return;

        setNavigationStack(stack => {
          const last = stack[stack.length - 1];
          const newIndex = (last.activeIndex + direction + items.length) % items.length;
          return [...stack.slice(0, -1), { ...last, activeIndex: newIndex }];
        });
    }, [currentView, nowPlayingMode, currentSong, menuItems, coverFlowItems, handleSetRating]);
    
    const handleSelectClick = useCallback(() => {
        if (currentView.id.startsWith('focus-setting-edit/')) {
            const key = currentView.id.split('/')[1] as keyof FocusSettings;
            const value = currentView.activeIndex;
            updateFocusSetting(key, value);
            setNavigationStack(s => s.slice(0, -1));
            return;
        }
        if (currentView.id === 'bounce-game') {
            if (['idle', 'game-over'].includes(bounceGame.gameState)) {
                menuItems[currentView.activeIndex]?.action();
            }
        } else if (currentView.id === 'now-playing') {
          setNowPlayingMode(mode => (mode === 'volume' ? 'rating' : 'volume'));
        } else if (currentView.id === 'load') {
          fileInputRef.current?.click();
        } else if (currentView.id === 'cover-flow' && coverFlowItems.length > 0) {
            const selectedAlbum = coverFlowItems[currentView.activeIndex].album;
            setNavigationStack(s => [...s, { id: `album-songs/${selectedAlbum}`, activeIndex: 0 }]);
        } else {
            menuItems[currentView.activeIndex]?.action();
        }
    }, [currentView, menuItems, coverFlowItems, bounceGame.gameState, updateFocusSetting]);

    const handleSelectLongPress = useCallback(async () => {
        const selectedMenuItem = menuItems[currentView.activeIndex];
        const songIdToAdd = selectedMenuItem?.songId;

        if (!songIdToAdd) return;

        try {
            let wasAdded = false;
            await db.transaction('rw', db.playlists, async () => {
                const otgPlaylist = await db.playlists.get({ name: 'On-The-Go' });

                if (otgPlaylist) {
                    // Playlist exists, update it if song not present
                    if (!otgPlaylist.songIds.includes(songIdToAdd)) {
                        await db.playlists.update(otgPlaylist.id!, { 
                            songIds: [...otgPlaylist.songIds, songIdToAdd]
                        });
                        wasAdded = true;
                    }
                } else {
                    // Playlist does not exist, create it with the new song
                    await db.playlists.add({ name: 'On-The-Go', songIds: [songIdToAdd] });
                    wasAdded = true;
                }
            });

            if (wasAdded) {
                setIsFlashing(true);
                setTimeout(() => setIsFlashing(false), 300);
            }
        } catch (error) {
            console.error("Failed to add song to On-The-Go playlist:", error);
        }
    }, [menuItems, currentView.activeIndex]);
    
    const getScreenTitle = () => {
      const viewId = currentView.id;
      const viewParam = viewId.includes('/') ? viewId.split('/')[1] : undefined;
      if (viewId === 'main') return 'ReactPod';
      if (viewId === 'now-playing') return 'Now Playing';
      if (viewId === 'cover-flow') return 'Cover Flow';
      if (viewId === 'search') return 'Search';
      if (viewId === 'playlists') return 'Playlists';
      if (viewId.startsWith('playlist-songs/')) {
        if (!allPlaylists) return 'Playlist';
        const playlistId = parseInt(viewParam!, 10);
        const playlist = allPlaylists.find(p => p.id === playlistId);
        return playlist ? playlist.name : 'Playlist';
      }
      if (viewId === 'ratings') return 'Ratings';
      if (viewId === 'about') return 'About';
      if (viewId === 'appearance') return 'Appearance';
      if (viewId === 'body-color') return 'iPod Body Color';
      if (viewId === 'wheel-color') return 'Click Wheel Color';
      if (viewId === 'library-management') return 'Library Management';
      if (viewId === 'clearing-library') return 'Clearing Library';
      if (viewId === 'focus') return 'Focus Timer';
      if (viewId === 'focus-settings') return 'Focus Settings';
      if (viewId === 'focus-stats') return 'Focus Stats';
      if (viewId === 'focus-reset-confirm') return 'Reset Stats?';
      if (viewId.startsWith('focus-setting-edit/')) return viewParam?.replace(/([A-Z])/g, ' $1').replace('Minutes', ' Duration').replace('Interval', ' Length').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Edit';
      if (viewId === 'bounce-game') {
          return bounceGame.gameState === 'game-over' ? `Game Over | Score: ${bounceGame.score}` : `Bounce | Score: ${bounceGame.score}`;
      }
      if (viewId.startsWith('rated-songs/')) return '★'.repeat(Number(viewParam)) + '☆'.repeat(5 - Number(viewParam));
      if (viewId === 'search-results') return `Results: ${searchQuery}`;
      if (viewId.startsWith('artist-albums/')) return decodeURIComponent(viewParam!);
      if (viewId.startsWith('album-songs/')) return decodeURIComponent(viewParam!);
      return viewId.charAt(0).toUpperCase() + viewId.slice(1);
    }

    const clickWheelIsPlaying = (() => {
      if (currentView.id.startsWith('focus')) {
        return focusState.isActive;
      }
      if (currentView.id === 'bounce-game') {
        return bounceGame.gameState === 'playing';
      }
      return isPlaying;
    })();

    const renderScreenContent = () => {
        const isInitialLoad = songs.length === 0 && !focusSettings;

        if (currentView.id === 'load' || (isLoading && isInitialLoad)) {
            return <FileLoadView isLoading={isLoading} loadingProgress={loadingProgress} onLoad={() => fileInputRef.current?.click()} isInitialLoad={songs.length === 0} />;
        }
        if (currentView.id === 'clearing-library') {
            return <ClearingLibraryView isClearing={clearingState.isClearing} message={clearingState.message} />;
        }
        if (currentView.id === 'now-playing' && currentSong) {
            const trackIndex = currentTrackId !== null ? playQueue.indexOf(currentTrackId) : -1;
            const totalTracks = playQueue.length;
            return <NowPlayingView 
                song={currentSong} 
                isPlaying={isPlaying} 
                currentTime={currentTime} 
                duration={duration || currentSong.duration} 
                volume={volume} 
                mode={nowPlayingMode}
                trackNumber={trackIndex + 1}
                totalTracks={totalTracks}
            />;
        }
        if (currentView.id === 'cover-flow') {
            return <CoverFlowView items={coverFlowItems} activeIndex={currentView.activeIndex} />;
        }
        if (currentView.id === 'search') {
            return <SearchView query={searchQuery} items={menuItems} activeIndex={currentView.activeIndex} />;
        }
        if (currentView.id === 'about') {
            return (
                <div className="flex flex-col items-center justify-center h-full text-center text-gray-800 p-4 space-y-2">
                    <h2 className="text-lg font-bold">ReactPod</h2>
                    <p>Developed by Revanth Atmakuri</p>
                </div>
            );
        }
        if (currentView.id === 'bounce-game') {
            if (['playing', 'paused', 'idle'].includes(bounceGame.gameState)) {
                return <BounceGameView {...bounceGame} ballRef={ballRef} paddleRef={paddleRef} />;
            }
            return <MenuView items={menuItems} activeIndex={currentView.activeIndex} />;
        }
        if (currentView.id === 'focus' && focusSettings) {
            if (focusSettings.fullscreenBreak && focusState.isActive && focusState.sessionType.includes('Break')) {
                return <FullscreenBreakView state={focusState} />;
            }
            return <FocusTimerView state={focusState} settings={focusSettings} stats={todayStats} />;
        }
        if (currentView.id === 'focus-stats') {
            return <FocusStatsView />;
        }
        if (currentView.id.startsWith('focus-setting-edit/')) {
            const key = currentView.id.split('/')[1];
            const value = currentView.activeIndex;
            const title = key.replace(/([A-Z])/g, ' $1').replace('Minutes', '(min)');
            return (
                <div className="h-full flex flex-col justify-center items-center text-center p-4 text-gray-800">
                    <p className="font-bold text-lg capitalize">{title}</p>
                    <p className="text-6xl font-mono tracking-tighter my-4">{value}</p>
                    <p className="text-sm text-gray-500">Scroll to change</p>
                    <p className="text-xs text-gray-500 mt-2">Press Menu or Select to save</p>
                </div>
            );
        }
        if (currentView.id === 'search-results' && menuItems.length === 0 && searchQuery) {
             return <div className="p-4 text-center font-bold text-gray-600">No Results Found</div>
        }
        if (menuItems.length === 0 && !['about', 'load', 'main', 'cover-flow', 'search', 'focus-stats'].includes(currentView.id) && !currentView.id.startsWith('focus-setting-edit')) {
          return <div className="p-4 text-center font-bold text-gray-600">No Items</div>
        }
        return <MenuView items={menuItems} activeIndex={currentView.activeIndex} />;
    };
    
    return (
        <div className={`w-[320px] h-[520px] ${ipodColors.body} rounded-[40px] shadow-2xl p-4 flex flex-col border-2 border-gray-400 select-none`}>
            <input type="file" ref={fileInputRef} onChange={handleFileChange} multiple directory="" webkitdirectory="" accept={SUPPORTED_EXTENSIONS.join(',')} className="hidden" />
            <Screen title={getScreenTitle()} isFlashing={isFlashing}>
              {renderScreenContent()}
            </Screen>
            <ClickWheel 
              onScroll={handleScroll} 
              onMenuClick={handleMenuClick} 
              onPlayPauseClick={handlePlayPause} 
              onNextClick={handleNext} 
              onPrevClick={handlePrev} 
              onSelectClick={handleSelectClick} 
              onSelectLongPress={handleSelectLongPress}
              isPlaying={clickWheelIsPlaying} 
              wheelClass={ipodColors.wheel}
            />
        </div>
    );
};

export default App;
