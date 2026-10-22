import { useState } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { Info } from "lucide-react";
import Start from "@/pages/Start";
import Camp from "@/pages/Camp";
import Arena from "@/pages/Arena";
import { MoveLearnerModal } from "@/components/MoveLearnerModal";
import { EvolutionModal } from "@/components/EvolutionModal";
import MechanicsModal from "@/components/MechanicsModal";
import MoveChartModal from "@/components/MoveChartModal";

export default function App() {
  const [showMechanics, setShowMechanics] = useState(false);
  const [showMoveChart, setShowMoveChart] = useState(false);

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Start />} />
        <Route path="/camp" element={<Camp onShowMechanics={() => setShowMechanics(true)} onShowMoveChart={() => setShowMoveChart(true)} />} />
        <Route path="/arena" element={<Arena onShowMechanics={() => setShowMechanics(true)} onShowMoveChart={() => setShowMoveChart(true)} />} />
      </Routes>
      <MoveLearnerModal />
      <EvolutionModal />
      {showMechanics && <MechanicsModal onClose={() => setShowMechanics(false)} />}
      {showMoveChart && <MoveChartModal onClose={() => setShowMoveChart(false)} />}
    </Router>
  );
}
