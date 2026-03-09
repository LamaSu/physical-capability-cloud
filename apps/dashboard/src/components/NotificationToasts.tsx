import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNotificationStore } from "../stores/notification-store.js";

const typeColors = {
  info: "border-green-500/20 bg-green-500/5",
  success: "border-green-400/30 bg-green-400/10",
  warning: "border-gold-400/30 bg-gold-400/10",
  error: "border-red-500/30 bg-red-500/10",
};

const typeTextColors = {
  info: "text-green-400/80",
  success: "text-green-300/80",
  warning: "text-gold-300/80",
  error: "text-red-400/80",
};

export function NotificationToasts() {
  const { notifications, dismiss } = useNotificationStore();

  // Auto-dismiss after 5 seconds
  React.useEffect(() => {
    const timers = notifications.map((n) =>
      setTimeout(() => dismiss(n.id), 5000),
    );
    return () => timers.forEach(clearTimeout);
  }, [notifications, dismiss]);

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 w-80">
      <AnimatePresence>
        {notifications.slice(-5).map((n) => (
          <motion.div
            key={n.id}
            initial={{ opacity: 0, x: 100, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 100, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={`rounded-xl border backdrop-blur-xl p-3 cursor-pointer ${typeColors[n.type]}`}
            onClick={() => dismiss(n.id)}
          >
            <div className={`text-sm font-medium ${typeTextColors[n.type]}`}>{n.title}</div>
            {n.message && <div className="text-xs text-white/40 mt-0.5">{n.message}</div>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
