import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Camera, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function QRScanner({ onScan, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [hasCamera, setHasCamera] = useState(false);
  const [stream, setStream] = useState(null);

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, []);

  const startCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        setStream(mediaStream);
        setHasCamera(true);
      }
    } catch (err) {
      console.log('Camera not available, using demo mode');
      setHasCamera(false);
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
  };

  const handleDemoScan = () => {
    // Simulate scanning a merchant QR code
    const demoPayments = [
      { address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38', merchant: 'Campus Coffee Shop', amount: 4.50 },
      { address: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72', merchant: 'University Bookstore', amount: 25.00 },
      { address: '0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec', merchant: 'Student Cafeteria', amount: 8.75 },
      { address: '0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097', merchant: 'Library Print Service', amount: 2.00 },
    ];
    const random = demoPayments[Math.floor(Math.random() * demoPayments.length)];
    onScan(random);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4">
        <h2 className="text-lg font-semibold">Scan QR Code</h2>
        <button onClick={onClose} className="p-2 rounded-xl hover:bg-secondary transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Scanner area */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="relative w-full max-w-[280px] aspect-square rounded-3xl overflow-hidden border-2 border-primary/30 bg-secondary">
          {hasCamera ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-3">
              <Camera className="w-12 h-12 text-muted-foreground" />
              <p className="text-xs text-muted-foreground text-center px-4">
                Camera not available in preview
              </p>
            </div>
          )}

          {/* Scanner overlay */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-primary rounded-tl-xl" />
            <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-primary rounded-tr-xl" />
            <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-primary rounded-bl-xl" />
            <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-primary rounded-br-xl" />
          </div>

          {/* Scanning line animation */}
          <motion.div
            className="absolute left-4 right-4 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent"
            initial={{ top: '10%' }}
            animate={{ top: ['10%', '90%', '10%'] }}
            transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
          />
          <canvas ref={canvasRef} className="hidden" />
        </div>

        <p className="text-sm text-muted-foreground mt-6 text-center">
          Point your camera at a merchant's QR code to pay
        </p>

        {/* Demo scan button */}
        <Button
          onClick={handleDemoScan}
          className="mt-6 bg-primary hover:bg-primary/90 rounded-xl gap-2"
        >
          <Zap className="w-4 h-4" />
          Demo Scan
        </Button>
        <p className="text-[10px] text-muted-foreground mt-2">
          Tap to simulate scanning a merchant QR code
        </p>
      </div>
    </motion.div>
  );
}