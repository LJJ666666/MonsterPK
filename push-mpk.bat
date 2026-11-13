@echo off
setlocal
cd /d "%~dp0" || (echo Cannot locate repo directory & pause & exit /b 1)

set MAX_TRIES=5
set TRY=0

echo ============================================
echo  MonsterPK - push to GitHub (host network)
echo  Repo: %CD%
echo ============================================
echo.

:retry
set /a TRY+=1
echo -------- attempt %TRY% / %MAX_TRIES% --------

echo [1] Fetching origin ...
git fetch origin --tags --quiet
echo.
echo [2] Status vs origin/master:
git status -sb
echo.
echo [3] Commits ahead of origin/master:
git --no-pager log --oneline origin/master..HEAD
echo.
echo [4] Pushing master + tags ...
git push origin master --tags
if %errorlevel%==0 (
  echo.
  echo [OK] Push succeeded.
  git ls-remote origin master
  goto :done
) else (
  echo.
  echo [WARN] Attempt %TRY% failed.
  if %TRY% LSS %MAX_TRIES% (
    echo Retrying in 5 seconds ...
    timeout /t 5 /nobreak >nul
    goto :retry
  ) else (
    echo [FAIL] All %MAX_TRIES% attempts failed, see errors above.
  )
)

:done
echo.
pause
